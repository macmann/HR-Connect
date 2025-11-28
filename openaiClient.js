const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function generateInterviewQuestionsForPosition(position) {
  const { title, description, department, employmentType } = position;

  const prompt = `
You are an HR expert. Generate a list of 5-8 thoughtful written interview questions for a candidate applying for the following position.

Return ONLY a valid JSON array of objects with fields:
- "id": a short identifier like "q1", "q2", ...
- "text": the question text

Position title: ${title || ''}
Department: ${department || ''}
Employment type: ${employmentType || ''}
Description: ${description || ''}

The questions should:
- Be open-ended
- Reveal experience, thinking process, and communication
- Be suitable for a written interview (text answers)
`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You output strictly valid JSON only. Do NOT include markdown code fences. Do NOT include explanations.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7
  });

  let content = response.choices[0].message.content.trim();

  // Clean markdown fences like ```json ... ```
  if (content.startsWith("```")) {
    content = content.replace(/^```[a-zA-Z]*\s*/, "") // remove opening ``` or ```json
                     .replace(/```$/, "") // remove trailing ```
                     .trim();
  }

  let questions;
  try {
    questions = JSON.parse(content);
  } catch (err) {
    console.error('Failed to parse OpenAI JSON for interview questions:', content);
    throw new Error('invalid_ai_questions_json');
  }

  if (!Array.isArray(questions)) {
    throw new Error('invalid_ai_questions_format');
  }

  return questions;
}

async function analyzeInterviewResponses(payload) {
  // payload should contain:
  // {
  //   positionTitle,
  //   positionDescription,
  //   candidateName,
  //   questions: [{ id, text }],
  //   answers: [{ questionId, answerText }]
  // }

  const prompt = `
You are an HR and hiring expert. You are given a position description and a candidate's written answers to interview questions.

Evaluate the candidate for this position and respond ONLY with valid JSON matching this structure:

{
  "scores": {
    "overall": number (1-5),
    "communication": number (1-5),
    "technical": number (1-5),
    "cultureFit": number (1-5)
  },
  "verdict": "proceed" | "hold" | "reject",
  "summary": string,
  "strengths": string[],
  "risks": string[],
  "recommendedNextSteps": string[]
}

Position title: ${payload.positionTitle || ''}
Position description: ${payload.positionDescription || ''}

Candidate name: ${payload.candidateName || ''}

Questions and answers:
${payload.questions.map(q => {
  const ans = payload.answers.find(a => a.questionId === q.id);
  const answerText = ans ? ans.answerText : '';
  return `Q: ${q.text}\nA: ${answerText}\n`;
}).join('\n')}
`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are an HR assistant. Output strictly valid JSON." },
      { role: "user", content: prompt }
    ],
    temperature: 0.4,
  });

  const content = response.choices[0].message.content.trim();

  let result;
  try {
    result = JSON.parse(content);
  } catch (err) {
    console.error("Failed to parse OpenAI JSON for interview analysis:", content);
    throw new Error("invalid_ai_interview_analysis_json");
  }

  return { result, raw: content };
}

module.exports = { generateInterviewQuestionsForPosition, analyzeInterviewResponses };
