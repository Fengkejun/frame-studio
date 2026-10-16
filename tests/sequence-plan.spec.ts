import { test, expect } from '@playwright/test'
import {
  makeStarterWorkflow,
  compatible,
  type Shot,
} from '../src/features/workflow/model'
import { sequencePrompt } from '../src/features/workflow/sequencePlan'
import { productionPrompt } from '../src/features/workflow/production'

test('whole-sequence prompt preserves ordered timings and project continuity', () => {
  const workflow = makeStarterWorkflow()
  const shots = [4, 4, 4].map((duration, i) => ({
    id: `shot-${i}`,
    duration,
    videoPrompt: `动作 ${i}`,
    camera: '近景',
    dialogue: '',
  })) as Shot[]
  const prompt = sequencePrompt(workflow, shots)
  expect(prompt).toContain('0–4 秒')
  expect(prompt).toContain('4–8 秒')
  expect(prompt).toContain('8–12 秒')
  expect(prompt).toContain('12 秒的完整连续')
  expect(prompt).toContain(workflow.production!.characters)
  expect(prompt.indexOf('动作 0')).toBeLessThan(prompt.indexOf('动作 2'))
  expect(productionPrompt(workflow, '当前动作')).toContain(
    workflow.production!.scene,
  )
  expect(compatible('storyboard', 'video')).toBe(true)
  expect(compatible('image', 'video')).toBe(true)
})

test('prompt compiler never clamps a longer storyboard to a model limit', () => {
  const shots = [8, 8, 8].map((duration) => ({
    duration,
    videoPrompt: '动作',
    camera: '全景',
    dialogue: '',
  })) as Shot[]
  expect(sequencePrompt(makeStarterWorkflow(), shots)).toContain(
    '24 秒的完整连续',
  )
  expect(sequencePrompt(makeStarterWorkflow(), shots)).toContain('16–24 秒')
})
