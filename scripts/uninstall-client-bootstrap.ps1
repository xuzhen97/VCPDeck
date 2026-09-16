param([Parameter(Mandatory=$true)][string]$ServerOrigin)
$ErrorActionPreference = 'Stop'
$ServerOrigin = $ServerOrigin.TrimEnd('/')
function Fail([string]$Message) { throw "[vcpdeck] $Message" }
if ($PSVersionTable.PSVersion.Major -lt 5) { Fail '需要 PowerShell 5.1+' }

# ADR-0027：系统级卸载同样要求已提升的管理员 PowerShell，不申请 UAC。
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$isHighIntegrity = @($identity.Groups | Where-Object { $_.Value -match '^S-1-16-(12288|16384)$' }).Count -gt 0
if (-not $isAdmin -or -not $isHighIntegrity) {
  Fail '请以管理员身份运行 PowerShell 后重跑本命令（脚本不申请 UAC）'
}

# 优先使用 ProgramData 私有 runtime；仅在迁移尚未完成的旧用户安装上回退 PATH/旧用户私有 Node。
$runtimeRoot = Join-Path $env:ProgramData 'VCPDeck\Client\runtime\node'
$node = Get-ChildItem -Path $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  $node = Get-ChildItem -Path (Join-Path $HOME '.vcpdeck\runtime\node') -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $node) { Fail '找不到 Node.js；请先安装 Node.js 后重试' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) "vcpdeck-uninstall-client-$PID.cjs"
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$ServerOrigin/api/client-installer/assets/uninstall-client.cjs" -OutFile $tmp -TimeoutSec 120
  & $node $tmp
  if ($LASTEXITCODE -ne 0) { Fail "卸载器退出码 $LASTEXITCODE" }
} finally { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
