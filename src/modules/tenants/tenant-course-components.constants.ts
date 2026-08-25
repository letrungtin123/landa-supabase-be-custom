export const COURSE_COMPONENT_TYPES = [
  'video',
  'html',
  'problem',
  'la_media_quiz',
  'la_scenario_chat',
  'la_crossword',
  'la_sortable',
  'la_diagram',
  'la_faq',
  'la_pdf',
] as const;

export type CourseComponentType = typeof COURSE_COMPONENT_TYPES[number];

const COURSE_COMPONENT_TYPE_SET = new Set<string>(COURSE_COMPONENT_TYPES);

export function isCourseComponentType(value: string): value is CourseComponentType {
  return COURSE_COMPONENT_TYPE_SET.has(value);
}

export function normalizeCourseComponentTypes(raw: unknown): CourseComponentType[] {
  if (!Array.isArray(raw)) return [...COURSE_COMPONENT_TYPES];

  const selected = new Set(
    raw.filter((type): type is CourseComponentType =>
      typeof type === 'string' && COURSE_COMPONENT_TYPE_SET.has(type),
    ),
  );

  return COURSE_COMPONENT_TYPES.filter(type => selected.has(type));
}
