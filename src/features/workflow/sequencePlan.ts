import type { Workflow, Shot } from './model'
import { productionText } from './production'
export function sequencePrompt(workflow: Workflow, shots: Shot[]) {
  let time = 0
  const lines = shots.map((s, i) => {
    const start = time
    time += s.duration
    return `分镜 ${i + 1}（${start}–${time} 秒）：${s.videoPrompt}\n机位：${s.camera}。${s.dialogue ? `台词：${s.dialogue}` : ''}`
  })
  return `${productionText(workflow)}\n\n生成一条 ${time} 秒的完整连续动漫短片，包含下列按时间顺序发生的分镜。所有分镜使用同一角色、同一套服装、同一场景和画风。保持动作因果与道具状态连续，镜头切换时不要重新设计人物或切换季节。不要生成分屏、九宫格、分镜板或画面文字。\n${lines.join('\n\n')}\n完整结尾，自然衔接；各时间段是创作指令，优先保持叙事连贯。`
}
