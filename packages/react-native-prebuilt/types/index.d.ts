import { type BuildOptions } from 'esbuild';
export declare function buildAll(): Promise<void>;
export declare function buildReactJSX(options?: BuildOptions): Promise<void>;
export declare function buildReact(options?: BuildOptions): Promise<void>;
export declare function buildReactNative(options: BuildOptions | undefined, { platform }: {
    platform: 'ios' | 'android';
}): Promise<void>;
//# sourceMappingURL=index.d.ts.map