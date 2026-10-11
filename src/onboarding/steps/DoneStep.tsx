import type { Settings } from '../../api/tauri'
import type { I18n } from '../../components/i18n'
import { OnboardingStepFrame } from '../OnboardingStepFrame'
import { webSearchConfigured } from '../validation'

type DoneStepProps = {
  t: I18n
  settings: Settings
}

function SummaryRow({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="onboarding-summary-row">
      <span className="onboarding-summary-label">{label}</span>
      <span className={`onboarding-summary-value${multiline ? ' onboarding-summary-value--multiline' : ''}`}>
        {value}
      </span>
    </div>
  )
}

export function DoneStep({ t, settings }: DoneStepProps) {
  return (
    <OnboardingStepFrame title={t.onboardingDoneTitle} subtitle={t.onboardingDoneDesc}>
      <div className="onboarding-section">
        <div className="onboarding-section-label">{t.onboardingDoneNextTitle}</div>
        <div className="onboarding-card onboarding-card--rows">
          <p className="onboarding-field-hint">{t.onboardingDoneNextChat}</p>
          <p className="onboarding-field-hint">{t.onboardingDoneNextTasks}</p>
          <p className="onboarding-field-hint">{t.onboardingDoneNextMedia}</p>
        </div>
      </div>
      <div className="onboarding-section">
        <div className="onboarding-section-label">{t.onboardingDoneSectionModels}</div>
        <div className="onboarding-card onboarding-card--rows">
          <div className="onboarding-summary-list">
            <SummaryRow
              label={`${t.webSearchChatSection} · ${t.onboardingDoneWebSearch}`}
              value={webSearchConfigured(settings) && settings.chatTools.nativeTools?.webSearch !== false
                ? t.enabled
                : t.onboardingDoneDisabled}
            />
          </div>
        </div>
      </div>
    </OnboardingStepFrame>
  )
}
