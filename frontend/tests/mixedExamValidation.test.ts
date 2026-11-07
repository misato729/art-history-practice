import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import { EXAM_CONFIG } from '../shared/examConfig.ts'
import { parseExamConfig, questionCountForExam, choiceLabelsForQuestion } from '../shared/schemas/exam.ts'
import { parseQuestionInput, parseQuestionArchiveEntries, ContentValidationError } from '../shared/schemas/content.ts'

const content = JSON.parse(readFileSync(new URL('../../content/questions.json', import.meta.url), 'utf8'))
const mock = JSON.parse(readFileSync(new URL('../../content/mock-exams/mock-01/questions.json', import.meta.url), 'utf8'))
test('eight catalog sets retain Mock1 and contain the 680 authored four-choice questions', () => {
  const parsed = parseQuestionArchiveEntries(content.questions, EXAM_CONFIG)
  assert.equal(parsed.length, 680)
  assert.equal(parsed.reduce((n,q)=>n+q.choices.length,0),2720)
  assert.equal(EXAM_CONFIG.exam.set_count,8)
  for (const exam of [1,2,3,4,5,6,7,8]) {
    const standalone = JSON.parse(readFileSync(new URL(`../../content/mock-exams/mock-${String(exam).padStart(2,'0')}/questions.json`, import.meta.url), 'utf8'))
    const integrated = parsed.filter(question => question.exam_number === exam)
    assert.equal(isDeepStrictEqual(integrated, standalone.questions), true)
    assert.equal(questionCountForExam(EXAM_CONFIG,exam),85)
    for (const number of [1,9,80,81,85]) assert.equal(choiceLabelsForQuestion(EXAM_CONFIG,exam,number).length,4)
  }
  assert.equal(isDeepStrictEqual(parsed.filter(question => question.exam_number === 1),mock.questions),true)
  assert.equal(questionCountForExam(EXAM_CONFIG,9),0)
})
test('question and choice boundaries follow the set and section on every shared input path', () => {
  for (const [exam,number] of [[1,86],[9,1],[0,1],[5,86]]) {
    assert.throws(()=>parseQuestionInput({...structuredClone(content.questions[0]),exam_number:exam,question_number:number},EXAM_CONFIG),ContentValidationError)
  }
  const application=structuredClone(content.questions.find((q:any)=>q.exam_number===1 && q.question_number===81))
  assert.equal(parseQuestionInput({...application,question_number:80},EXAM_CONFIG).choices.length,4)
  assert.throws(()=>parseQuestionInput({...application,choices:application.choices.slice(0,3)},EXAM_CONFIG),ContentValidationError)
  const wrong=structuredClone(application);wrong.choices[3].choice_label='オ'
  assert.throws(()=>parseQuestionInput(wrong,EXAM_CONFIG),ContentValidationError)
  const duplicated=structuredClone(application);duplicated.choices[0].is_correct=true;duplicated.choices[1].is_correct=true
  assert.throws(()=>parseQuestionInput(duplicated,EXAM_CONFIG),ContentValidationError)
})
test('shared schemas retain mixed four/six-choice support independently of this all-four-choice mock', () => {
  const raw=structuredClone(EXAM_CONFIG)
  raw.exam.sets![0]!.sections![1]!.choice_labels=['ア','イ','ウ','エ','オ','カ']
  const config=parseExamConfig(raw)
  const six=structuredClone(content.questions.find((q:any)=>q.question_number===81))
  six.choices=[...six.choices, ...['オ','カ'].map((choice_label,index)=>({choice_label,display_order:index+5,is_correct:false,content_blocks:[{type:'text',text:'Synthetic extra choice '+index}]}))]
  assert.equal(parseQuestionInput(six,config).choices.length,6)
  assert.throws(()=>parseQuestionInput(six,EXAM_CONFIG),ContentValidationError)
  assert.throws(()=>parseQuestionInput({...six,question_number:80},config),ContentValidationError)
  assert.throws(()=>parseQuestionInput({...six,choices:six.choices.slice(0,4)},config),ContentValidationError)
  assert.equal(choiceLabelsForQuestion(config,1,80).length,4)
  assert.equal(choiceLabelsForQuestion(config,1,81).length,6)
})
test('set definitions reject missing sets, overlaps, gaps, out-of-range sections and duplicate labels', () => {
  const changes=[
    (c:any)=>{c.exam.sets.pop()},
    (c:any)=>{c.exam.sets[0].exam_number=2},
    (c:any)=>{c.exam.sets[0].sections[1].first=80},
    (c:any)=>{c.exam.sets[0].sections[1].first=82},
    (c:any)=>{c.exam.sets[0].sections[1].last=86},
    (c:any)=>{c.exam.sets[0].sections[1].last=84},
    (c:any)=>{c.exam.sets[0].sections[1].choice_labels=['ア','ア']},
    (c:any)=>{c.exam.sets[0].sections=[]},
  ]
  for (const change of changes) {const config=structuredClone(EXAM_CONFIG);change(config);assert.throws(()=>parseExamConfig(config))}
  const legacy=structuredClone(EXAM_CONFIG);delete legacy.exam.sets
  const config=parseExamConfig(legacy)
  assert.equal(questionCountForExam(config,1),config.exam.questions_per_exam)
  assert.deepEqual(choiceLabelsForQuestion(config,1,1),config.exam.choice_labels)
})
