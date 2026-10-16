import { mkdir, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTutorialApp } from './tutorial-runtime.mjs'
import { createAgentFixture, testAgent } from './agent-smoke.mjs'
import { expect } from '@playwright/test'
const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(path.join(root, 'artifacts'), { recursive: true })
const profile = await mkdtemp(path.join(root, 'artifacts/agent-test-'))
const fixture = await createAgentFixture(root)
let app = await openTutorialApp(root, profile, profile)
try {
  await testAgent(app.page, root, profile, fixture)
  const config = await app.invoke('get_agent_config')
  fixture.relay.setMode('hold')
  const started = await app.invoke('start_agent', {
    request: {
      goal: '测试原任务恢复的连续动漫短片',
      config,
      referenceVersionId: null,
      parentId: null,
      scriptOnly: false,
    },
  })
  await expect
    .poll(
      async () => {
        const s = await app.invoke('get_agent_session', { id: started.id })
        if (!s.videoJobId) return false
        return (
          await app.invoke('list_video_jobs', { workflowId: s.workflowId })
        ).find((j) => j.id === s.videoJobId)?.taskId
      },
      { timeout: 15000 },
    )
    .toBeTruthy()
  const submissions = fixture.relay.requests.length
  await app.close()
  app = await openTutorialApp(root, profile, profile)
  expect(
    (await app.invoke('get_agent_session', { id: started.id })).status,
  ).toBe('interrupted')
  fixture.relay.setMode('success')
  await app.invoke('resume_agent', { id: started.id })
  await expect
    .poll(
      async () =>
        (await app.invoke('get_agent_session', { id: started.id })).status,
      { timeout: 25000 },
    )
    .toBe('succeeded')
  expect(fixture.relay.requests.length).toBe(submissions)
  console.log(
    'PASS: genuine app restart preserves Agent job identity and resumes the original remote video without another POST.',
  )
} catch (error) {
  await app.page
    .screenshot({ path: path.join(profile, 'agent-failure.png') })
    .catch(() => {})
  console.error(`Agent test profile: ${profile}`)
  throw error
} finally {
  await app.close()
  await fixture.close()
}
