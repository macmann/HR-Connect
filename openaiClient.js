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

async function analyzeCvAgainstJd({ cvText, jdText, positionTitle, candidateName }) {
  if (!cvText || !jdText) {
    throw new Error('Both cvText and jdText are required for analysis.');
  }

  const prompt = `
You are an HR assistant helping a recruiter evaluate candidates.

Analyze the following candidate CV text against the job description.

Return a JSON object with:
- summary: brief 3-5 sentence summary of candidate profile
- fitScore: a number from 0 to 100 indicating how well the candidate fits this JD
- strengths: array of 3-6 bullet points
- risks: array of 2-5 bullet points
- recommendation: one of "Strong Fit", "Good Fit", "Borderline", "Not Recommended"

If any information is unclear or missing, infer cautiously but DO NOT fabricate facts.

Position title: ${positionTitle || "N/A"}
Candidate name: ${candidateName || "N/A"}

JOB DESCRIPTION:
----------------
${jdText}

CV TEXT:
--------
${cvText}
`;

  const response = await client.responses.create({
    model: process.env.OPENAI_CV_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: prompt,
    response_format: { type: 'json_schema', json_schema: {
      name: 'CvScreeningResult',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          fitScore: { type: 'number' },
          strengths: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' }
        },
        required: ['summary', 'fitScore', 'strengths', 'risks', 'recommendation'],
        additionalProperties: false
      }
    }}
  });

  const content = response.output[0]?.content?.[0]?.text?.value;
  if (!content) {
    throw new Error('Empty response from OpenAI for CV analysis');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error('Failed to parse CV analysis JSON:', content);
    throw new Error('Invalid JSON from CV analysis model');
  }

  return parsed;
}

module.exports = { generateInterviewQuestionsForPosition, analyzeInterviewResponses, analyzeCvAgainstJd };
