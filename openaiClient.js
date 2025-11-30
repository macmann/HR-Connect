const OpenAI = require('openai');
const { DEFAULT_AI_SETTINGS } = require('./aiSettings');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function createChatCompletionWithFallback(params) {
  try {
    return await client.chat.completions.create(params);
  } catch (err) {
    if (err && err.code === 'unsupported_value' && err.param === 'temperature') {
      const { temperature, ...retryParams } = params;
      console.warn(
        `Temperature ${temperature} unsupported for model ${params.model}; retrying with default temperature.`,
      );

      return await client.chat.completions.create(retryParams);
    }

    throw err;
  }
}

function getCvAnalysisModel() {
  // Highest priority: explicit override
  if (process.env.OPENAI_CV_MODEL && process.env.OPENAI_CV_MODEL.trim()) {
    return process.env.OPENAI_CV_MODEL.trim();
  }

  // Default model for CV screening
  return "gpt-5-mini-2025-08-07";
}

async function generateInterviewQuestionsForPosition(position, options = {}) {
  const { title, description, department, employmentType } = position;
  const promptIntro = options.questionPrompt || DEFAULT_AI_SETTINGS.questionPrompt;

  const prompt = `${promptIntro}

Position title: ${title || ''}
Department: ${department || ''}
Employment type: ${employmentType || ''}
Description: ${description || ''}`;

  const response = await createChatCompletionWithFallback({
    model: options.model || 'gpt-5.1-mini',
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

  const response = await createChatCompletionWithFallback({
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

async function analyzeCvAgainstJd({ cvText, jdText, positionTitle, candidateName }, options = {}) {
  if (!cvText || !jdText) {
    throw new Error("Both cvText and jdText are required for analysis.");
  }

  const promptIntro = options.screeningPrompt || DEFAULT_AI_SETTINGS.screeningPrompt;
  const prompt = `${promptIntro}

Position title: ${positionTitle || "N/A"}
Candidate name: ${candidateName || "N/A"}

JOB DESCRIPTION:
----------------
${jdText}

CV TEXT:
--------
${cvText}`;

  const primaryModel = getCvAnalysisModel();
  let completion;

  try {
    completion = await createChatCompletionWithFallback({
      model: primaryModel,
      messages: [
        {
          role: "system",
          content:
            "You are a precise HR assistant. You ONLY respond with strict JSON matching the requested schema. No markdown, no commentary."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
    });
  } catch (err) {
    if (err && err.code === "model_not_found") {
      console.warn(
        "Primary CV screening model not found:", primaryModel,
        "— retrying with fallback model gpt-4o-mini"
      );

      completion = await createChatCompletionWithFallback({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a precise HR assistant. You ONLY respond with strict JSON matching the requested schema. No markdown, no commentary."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
      });
    } else {
      throw err;
    }
  }

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

module.exports = {
  generateInterviewQuestionsForPosition,
  analyzeInterviewResponses,
  analyzeCvAgainstJd,
};
