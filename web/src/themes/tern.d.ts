// Tern's themes as vite.config.ts builds them from tern/*.json.
declare module "virtual:tern-themes" {
  const sources: Omit<import("../termTheme").TermSource, "id">[];
  export default sources;
}
