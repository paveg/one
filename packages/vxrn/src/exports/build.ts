import FSExtra from 'fs-extra'
import { rm } from 'node:fs/promises'
import type { RollupOutput } from 'rollup'
import {
  loadConfigFromFile,
  mergeConfig,
  build as viteBuild,
  type InlineConfig,
  type Plugin,
  type UserConfig,
} from 'vite'
import { analyzer } from 'vite-bundle-analyzer'
import type { BuildArgs, VXRNOptions } from '../types'
import { getBaseViteConfig } from '../utils/getBaseViteConfig'
import { getOptimizeDeps } from '../utils/getOptimizeDeps'
import { getOptionsFilled } from '../utils/getOptionsFilled'
import { mergeUserConfig } from '../utils/mergeUserConfig'
import { applyBuiltInPatches } from '../utils/patches'
import { requireResolve } from '../utils/requireResolve'

const { existsSync } = FSExtra

Error.stackTraceLimit = Number.POSITIVE_INFINITY

const disableOptimizationConfig = {
  optimizeDeps: {
    esbuildOptions: {
      minify: false,
    },
  },

  build: {
    minify: false,
    rollupOptions: {
      treeshake: false,
      output: {
        minifyInternalExports: false,
      },
    },
  },
} satisfies UserConfig

export const build = async (optionsIn: VXRNOptions, buildArgs: BuildArgs = {}) => {
  // set NODE_ENV, do before loading vite.config (see loadConfigFromFile)
  process.env.NODE_ENV = 'production'

  const [options, userViteConfig] = await Promise.all([
    getOptionsFilled(optionsIn),
    loadConfigFromFile({
      command: 'build',
      mode: 'prod',
    }).then((_) => _?.config),
  ])

  await applyBuiltInPatches(options).catch((err) => {
    console.error(`\n 🥺 error applying built-in patches`, err)
  })

  // clean
  await Promise.all([
    (async () => {
      // lets always clean dist folder for now to be sure were correct
      if (existsSync('dist')) {
        await rm('dist', { recursive: true, force: true })
      }
    })(),
    (async () => {
      // lets always clean dist folder for now to be sure were correct
      if (existsSync('node_modules/.vite')) {
        await rm('node_modules/.vite', { recursive: true, force: true })
      }
    })(),
  ])

  const { optimizeDeps } = getOptimizeDeps('build')

  let webBuildConfig = mergeConfig(
    getBaseViteConfig({
      mode: 'production',
    }),
    {
      clearScreen: false,
      configFile: false,
      optimizeDeps,
    } satisfies InlineConfig
  )

  const rerouteNoExternalConfig = userViteConfig?.ssr?.noExternal === true
  if (rerouteNoExternalConfig) {
    delete userViteConfig.ssr!.noExternal
  }

  webBuildConfig = mergeUserConfig(optimizeDeps, webBuildConfig, userViteConfig)

  const excludeAPIRoutesPlugin = {
    enforce: 'pre',
    name: 'omit-api-routes',
    transform(code, id) {
      if (/\+api.tsx?$/.test(id)) {
        return ``
      }
    },
  } satisfies Plugin

  let clientOutput

  if (buildArgs.step !== 'generate') {
    let clientBuildConfig = mergeConfig(webBuildConfig, {
      plugins: [
        excludeAPIRoutesPlugin,
        // if an error occurs (like can't find index.html, it seems to show an
        // error saying can't find report here instead, so a bit confusing)
        buildArgs.analyze || options.build?.analyze
          ? analyzer({
              analyzerMode: 'static',
              fileName: '../report',
            })
          : null,
      ],

      build: {
        ssrManifest: true,
        outDir: 'dist/client',
        manifest: true,
        rollupOptions: {
          input: ['virtual:vxs-entry'],
        },
      },
    } satisfies UserConfig)

    if (process.env.VXRN_DISABLE_PROD_OPTIMIZATION) {
      clientBuildConfig = mergeConfig(clientBuildConfig, disableOptimizationConfig)
    }

    console.info(`\n 🔨 build client\n`)

    const { output } = (await viteBuild(clientBuildConfig)) as RollupOutput
    clientOutput = output
  }

  const serverOptions = options.build?.server
  const shouldOutputCJS =
    typeof serverOptions !== 'object' ? false : serverOptions.outputFormat === 'cjs'

  // servers can get all the defines
  const processEnvDefines = Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => {
      return [`process.env.${key}`, JSON.stringify(value)]
    })
  )

  const serverResolve = {
    alias: {
      'react/jsx-runtime': requireResolve('@vxrn/vendor/react-jsx-19'),
      react: requireResolve('@vxrn/vendor/react-19-prod'),
      'react-dom/server.browser': requireResolve('@vxrn/vendor/react-dom-server.browser-19'),
      'react-dom/client': requireResolve('@vxrn/vendor/react-dom-client-19'),
      'react-dom': requireResolve('@vxrn/vendor/react-dom-19'),
    },
  }

  const rollupRemoveUnusedImportsPlugin = {
    name: 'remove-unused-imports',
    renderChunk(code) {
      // Use a simple regex or AST parser to remove unused imports
      // Here, we use a regex to remove all imports, adapt as needed
      return {
        code: code.replace(/import\s+['"][^'"]+['"];\n/g, ''),
        map: null,
      }
    },
  }

  let serverBuildConfig = mergeConfig(webBuildConfig, {
    plugins: [excludeAPIRoutesPlugin],

    define: {
      'process.env.TAMAGUI_IS_SERVER': '"1"',
      ...processEnvDefines,
      ...webBuildConfig.define,
    },

    // builder: {
    //   async buildApp(builder) {
    //     // console.warn('building??????')
    //     await builder.build(builder.environments.server)
    //   },
    // },

    resolve: serverResolve,

    ssr: {
      noExternal: true,
      optimizeDeps,
    },

    build: {
      // we want one big file of css
      cssCodeSplit: false,
      ssr: true,
      outDir: 'dist/server',
      rollupOptions: {
        plugins: [rollupRemoveUnusedImportsPlugin],
        treeshake: true,
        // fixes some weird issues with optimizing tamagui and other packages
        // external: (id) => {
        //   if (serverExternals.has(id)) return true
        //   return false
        //   // return /^@tamagui/.test(id)
        // },

        input: ['virtual:vxs-entry'],

        ...(shouldOutputCJS && {
          output: {
            format: 'cjs', // Ensure the format is set to 'cjs'
            entryFileNames: '[name].cjs', // Customize the output file extension
          },
        }),
      },
    },
  } satisfies UserConfig)

  if (rerouteNoExternalConfig) {
    serverBuildConfig.ssr!.noExternal = true
  }

  let serverOutput
  let clientManifest

  if (serverOptions !== false) {
    console.info(`\n 🔨 build server\n`)
    const { output } = (await viteBuild(serverBuildConfig)) as RollupOutput
    serverOutput = output
    clientManifest = await FSExtra.readJSON('dist/client/.vite/manifest.json')
  }

  return {
    options,
    buildArgs,
    clientOutput,
    serverOutput,
    rollupRemoveUnusedImportsPlugin,
    serverResolve,
    serverBuildConfig,
    webBuildConfig,
    clientManifest,
  }
}
