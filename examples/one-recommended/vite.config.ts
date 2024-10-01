import type { UserConfig } from 'vite'
import { one } from 'one/vite'
// import { tamaguiPlugin } from '@tamagui/vite-plugin'

export default {
  plugins: [
    one({
      web: {
        defaultRenderMode: 'ssg',
      },

      app: {
        key: 'One',
      },
    }),

    // tamaguiPlugin({
    //   optimize: true,
    //   components: ['tamagui'],
    //   config: './config/tamagui.config.ts',
    //   outputCSS: './features/styles/tamagui.css',
    // }),
  ],
} satisfies UserConfig