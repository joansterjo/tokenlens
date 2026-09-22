import packageMetadata from '../../package.json' with { type: 'json' };

// The default JSON import works in Node ESM as well as the browser build.
export const VERSION = packageMetadata.version;
