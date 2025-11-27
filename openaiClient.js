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
      { role: 'system', content: 'You output strictly valid JSON.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7
  });

  const content = response.choices[0].message.content.trim();

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

module.exports = { generateInterviewQuestionsForPosition };
