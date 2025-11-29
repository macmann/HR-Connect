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
    model: 'gpt-5.1-mini',
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
    model: "gpt-5.1-mini",
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
    throw new Error("Both cvText and jdText are required for analysis.");
  }

  const prompt = `
You are an HR assistant helping a recruiter evaluate candidates.

Analyze the following candidate CV text against the job description.

Return a JSON object with EXACTLY these fields and nothing else:

{
  "summary": string,                 // 3-5 sentence summary of candidate profile
  "fitScore": number,               // from 0 to 100, how well the candidate fits the JD
  "strengths": string[],            // 3-6 bullet points
  "risks": string[],                // 2-5 bullet points, gaps or concerns
  "recommendation": string          // one of: "Strong Fit", "Good Fit", "Borderline", "Not Recommended"
}

Rules:
- Output MUST be valid JSON.
- Do NOT include any markdown, backticks, or explanations.
- Do NOT include comments.
- Do NOT include trailing commas.
- If something is unclear, mention it briefly in "risks", but do not invent fake experience.

Position title: ${positionTitle || "N/A"}
Candidate name: ${candidateName || "N/A"}

JOB DESCRIPTION:
----------------
${jdText}

CV TEXT:
--------
${cvText}
`;

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_CV_MODEL || "gpt-5.1-mini",
    messages: [
      {
        role: "system",
        content: "You are a precise HR assistant. You ONLY respond with strict JSON matching the requested schema. No markdown, no commentary."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0.2,
  });

  let content = completion.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Empty response from OpenAI for CV analysis");
  }

  // Strip accidental ```json ... ``` fences if they appear
  if (content.startsWith("```")) {
    content = content.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  }

  try {
    const parsed = JSON.parse(content);
    return parsed;
  } catch (err) {
    console.error("Failed to parse CV analysis JSON:", content);
    throw new Error("Invalid JSON from CV analysis model");
  }
}

module.exports = { generateInterviewQuestionsForPosition, analyzeInterviewResponses, analyzeCvAgainstJd };
