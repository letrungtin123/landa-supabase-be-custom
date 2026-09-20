// ═══════════════════════════════════════════════════════════════
// Canonical starter XML for the five manual Problem component types.
// Keep this server-side so every API client receives the selected type,
// rather than relying on the editor's single-choice fallback for empty data.
// ═══════════════════════════════════════════════════════════════

const SINGLE_CHOICE_XML = `<problem>
  <multiplechoiceresponse>
    <label>Câu hỏi của bạn</label>
    <choicegroup type="MultipleChoice">
      <choice correct="true">Đáp án đúng</choice>
      <choice correct="false">Đáp án sai A</choice>
      <choice correct="false">Đáp án sai B</choice>
    </choicegroup>
  </multiplechoiceresponse>
</problem>`;

const PROBLEM_XML_BY_BOILERPLATE: Readonly<Record<string, string>> = {
  'multiplechoice.yaml': SINGLE_CHOICE_XML,
  'checkboxes_response.yaml': `<problem>
  <choiceresponse>
    <label>Câu hỏi của bạn</label>
    <checkboxgroup>
      <choice correct="true">Đáp án đúng A</choice>
      <choice correct="true">Đáp án đúng B</choice>
      <choice correct="false">Đáp án sai</choice>
    </checkboxgroup>
  </choiceresponse>
</problem>`,
  'optionresponse.yaml': `<problem>
  <optionresponse>
    <label>Câu hỏi của bạn</label>
    <optioninput>
      <option correct="true">Đáp án đúng</option>
      <option correct="false">Đáp án sai A</option>
      <option correct="false">Đáp án sai B</option>
    </optioninput>
  </optionresponse>
</problem>`,
  'numericalresponse.yaml': `<problem>
  <numericalresponse answer="100">
    <label>Câu hỏi số học của bạn</label>
    <responseparam type="tolerance" default="5%" />
    <formulaequationinput />
  </numericalresponse>
</problem>`,
  'string_response.yaml': `<problem>
  <stringresponse answer="đáp án đúng" type="ci">
    <label>Câu hỏi của bạn</label>
    <additional_answer answer="đáp án thay thế" />
    <textline size="30" />
  </stringresponse>
</problem>`,
};

/**
 * Return the selected Problem starter XML. Callers that supply an unknown
 * boilerplate deliberately receive the established single-choice default.
 */
export function getDefaultProblemXml(boilerplate?: string): string {
  return PROBLEM_XML_BY_BOILERPLATE[boilerplate || ''] || SINGLE_CHOICE_XML;
}
