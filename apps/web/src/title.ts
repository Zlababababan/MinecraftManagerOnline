/** Titre de page : `Section — Projet` ou `Projet` seul. */
export function pageTitle(project: string, section?: string): string {
  return section === undefined || section === '' ? project : `${section} — ${project}`;
}
