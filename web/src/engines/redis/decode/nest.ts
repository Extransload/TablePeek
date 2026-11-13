// Reads a string or bytes found inside a decoded value (a pickled dict's
// value, a PHP string) that itself holds JSON, a pickle or a PHP value:
// the decoded value tagged with its format ({ "__json__": … }), or
// undefined to keep it as it is.
export type Nest = (bytes: Uint8Array, text: boolean) => unknown;
