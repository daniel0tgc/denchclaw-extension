/**
 * Local type shim for the `psl` package.
 *
 * Upstream `psl@1.15.0` ships types at `types/index.d.ts` but does not
 * expose them through the `exports` field, so TypeScript with
 * `moduleResolution: bundler` can't find them. The deprecated `@types/psl`
 * is just an empty stub and doesn't help. This shim mirrors the public
 * API we actually use.
 */
declare module "psl" {
  export type ParsedDomain = {
    tld: string | null;
    sld: string | null;
    domain: string | null;
    subdomain: string | null;
    listed: boolean;
    input?: string;
  };

  export type ErrorResult = {
    input: string;
    error: {
      code: string;
      message: string;
    };
  };

  export function parse(domain: string): ParsedDomain | ErrorResult;
  export function get(domain: string): string | null;
  export function isValid(domain: string): boolean;

  const psl: {
    parse: typeof parse;
    get: typeof get;
    isValid: typeof isValid;
  };

  export default psl;
}
