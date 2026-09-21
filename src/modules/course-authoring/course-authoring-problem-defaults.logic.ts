// ═══════════════════════════════════════════════════════════════
// Canonical starter XML for the five manual Problem component types.
// Keep this server-side so every API client receives the selected type,
// rather than relying on the editor's single-choice fallback for empty data.
// ═══════════════════════════════════════════════════════════════

export type CourseComponentLocale = 'vi' | 'en';

const SINGLE_CHOICE_XML: Record<CourseComponentLocale, string> = {
  vi: `<problem>
  <multiplechoiceresponse>
    <label>Câu hỏi của bạn</label>
    <choicegroup type="MultipleChoice">
      <choice correct="true">Đáp án đúng</choice>
      <choice correct="false">Đáp án sai A</choice>
      <choice correct="false">Đáp án sai B</choice>
    </choicegroup>
  </multiplechoiceresponse>
</problem>`,
  en: `<problem>
  <multiplechoiceresponse>
    <label>Your question</label>
    <choicegroup type="MultipleChoice">
      <choice correct="true">Correct answer</choice>
      <choice correct="false">Incorrect answer A</choice>
      <choice correct="false">Incorrect answer B</choice>
    </choicegroup>
  </multiplechoiceresponse>
</problem>`,
};

const PROBLEM_XML_BY_BOILERPLATE: Readonly<Record<string, Record<CourseComponentLocale, string>>> = {
  'multiplechoice.yaml': SINGLE_CHOICE_XML,
  'checkboxes_response.yaml': {
    vi: `<problem>
  <choiceresponse>
    <label>Câu hỏi của bạn</label>
    <checkboxgroup>
      <choice correct="true">Đáp án đúng A</choice>
      <choice correct="true">Đáp án đúng B</choice>
      <choice correct="false">Đáp án sai</choice>
    </checkboxgroup>
  </choiceresponse>
</problem>`,
    en: `<problem>
  <choiceresponse>
    <label>Your question</label>
    <checkboxgroup>
      <choice correct="true">Correct answer A</choice>
      <choice correct="true">Correct answer B</choice>
      <choice correct="false">Incorrect answer</choice>
    </checkboxgroup>
  </choiceresponse>
</problem>`,
  },
  'optionresponse.yaml': {
    vi: `<problem>
  <optionresponse>
    <label>Câu hỏi của bạn</label>
    <optioninput>
      <option correct="true">Đáp án đúng</option>
      <option correct="false">Đáp án sai A</option>
      <option correct="false">Đáp án sai B</option>
    </optioninput>
  </optionresponse>
</problem>`,
    en: `<problem>
  <optionresponse>
    <label>Your question</label>
    <optioninput>
      <option correct="true">Correct answer</option>
      <option correct="false">Incorrect answer A</option>
      <option correct="false">Incorrect answer B</option>
    </optioninput>
  </optionresponse>
</problem>`,
  },
  'numericalresponse.yaml': {
    vi: `<problem>
  <numericalresponse answer="100">
    <label>Câu hỏi số học của bạn</label>
    <responseparam type="tolerance" default="5%" />
    <formulaequationinput />
  </numericalresponse>
</problem>`,
    en: `<problem>
  <numericalresponse answer="100">
    <label>Your numerical question</label>
    <responseparam type="tolerance" default="5%" />
    <formulaequationinput />
  </numericalresponse>
</problem>`,
  },
  'string_response.yaml': {
    vi: `<problem>
  <stringresponse answer="đáp án đúng" type="ci">
    <label>Câu hỏi của bạn</label>
    <additional_answer answer="đáp án thay thế" />
    <textline size="30" />
  </stringresponse>
</problem>`,
    en: `<problem>
  <stringresponse answer="correct answer" type="ci">
    <label>Your question</label>
    <additional_answer answer="alternative answer" />
    <textline size="30" />
  </stringresponse>
</problem>`,
  },
};

/**
 * Return the selected Problem starter XML. Callers that supply an unknown
 * boilerplate deliberately receive the established single-choice default.
 */
export function getDefaultProblemXml(
  boilerplate?: string,
  locale: CourseComponentLocale = 'vi',
): string {
  return (PROBLEM_XML_BY_BOILERPLATE[boilerplate || ''] || SINGLE_CHOICE_XML)[locale];
}
