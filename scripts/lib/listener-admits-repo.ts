import type { NormalizedSource } from "./config";
import { filterRepos } from "./filter-repos";

export function listenerAdmitsRepo(source: NormalizedSource, repo: string): boolean {
  const fullName = `${source.name}/${repo}`;
  return filterRepos(source.name, [fullName], source.allow, source.deny).length > 0;
}
