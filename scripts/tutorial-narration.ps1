param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
$taskPlan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskVoice = New-Object -ComObject SAPI.SpVoice
$taskVoices = $taskVoice.GetVoices('Language=804')
if ($taskVoices.Count -gt 0) { $taskVoice.Voice = $taskVoices.Item(0) }
$taskVoice.Rate = 1
foreach ($taskChapter in $taskPlan) {
  if (Test-Path -LiteralPath $taskChapter.voicePath) { continue }
  $taskStream = New-Object -ComObject SAPI.SpFileStream
  try {
    $taskStream.Open($taskChapter.voicePath, 3, $false)
    $taskVoice.AudioOutputStream = $taskStream
    $null = $taskVoice.Speak($taskChapter.text)
  } finally { $taskStream.Close() }
}
