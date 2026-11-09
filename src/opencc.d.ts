declare module "opencc-js/cn2t" {
  export function Converter(opts: { from: string; to: string }): (text: string) => string;
}
