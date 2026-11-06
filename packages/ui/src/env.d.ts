declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.css";
interface ImportMeta {
  glob(pattern: string, options: { eager: true }): Record<string, unknown>;
}
