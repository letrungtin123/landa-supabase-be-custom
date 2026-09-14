import type { LessonAuthorComponentProposal } from './course-authoring.service.js';

/** Keep FAQ blocks at the end of a unit without changing stable order. */
export function orderLessonAuthorComponents(
  components: LessonAuthorComponentProposal[],
): LessonAuthorComponentProposal[] {
  return [
    ...components.filter(component => component.type !== 'la_faq'),
    ...components.filter(component => component.type === 'la_faq'),
  ];
}
