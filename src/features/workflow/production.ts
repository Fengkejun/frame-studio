import type { Workflow } from './model'
export const emptyProduction = {
  style: '',
  characters: '',
  scene: '',
  rules: '',
}
export function productionText(w: Workflow) {
  const p = w.production
  if (!p || !Object.values(p).some((s) => s.trim())) return ''
  return `【全片统一设定】\n画风：${p.style}\n角色：${p.characters}\n场景：${p.scene}\n连续性要求：${p.rules}\n保持同一角色的脸型、发色、服装、道具和场景天气；镜头切换只改变机位与动作。`
}
export function productionPrompt(w: Workflow, prompt: string) {
  const text = productionText(w)
  return text ? `${text}\n\n【当前镜头】\n${prompt}` : prompt
}
