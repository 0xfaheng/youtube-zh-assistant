param([ValidateSet('Protect', 'Unprotect')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$secretInput = [Console]::In.ReadToEnd()
[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$secretEntropy = [Text.Encoding]::UTF8.GetBytes('youtube-zh-assistant-v1')
if ($Action -eq 'Protect') {
    $secretBytes = [Text.Encoding]::UTF8.GetBytes($secretInput)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($secretBytes, $secretEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
} else {
    $protectedBytes = [Convert]::FromBase64String($secretInput)
    $secretBytes = [Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $secretEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($secretBytes))
}
