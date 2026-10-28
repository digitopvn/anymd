export declare const PLUGIN_DIR: string;
export declare function readPlugin(dir?: string): any;
export declare function validatePlugin(dir?: string, plugin?: unknown): string[];
export declare function listingUrls(dir?: string): string[];
export declare function checkUrls(dir?: string): Promise<{ url: string; status: number; ok: boolean }[]>;
