export type OnboardingStepId =
  | 'welcome'
  | 'provider'
  | 'webSearch'
  | 'done'

// 不做语言选择步：首次运行按系统语言自动设定（见 OnboardingShell 的 detectSystemLang），
// 之后可在「设置 → 基础」里随时改。
// 手机端没有物理键盘，也不存在翻译 / Lens 窗口，故不做热键配置步。
export const ONBOARDING_STEPS: OnboardingStepId[] = [
  'welcome',
  'provider',
  'webSearch',
  'done',
]
