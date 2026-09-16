param([Parameter(Mandatory=$true)][string]$ServerOrigin)
$ErrorActionPreference = 'Stop'
$ServerOrigin = $ServerOrigin.TrimEnd('/')
function Fail([string]$Message) { throw "[vcpdeck] $Message" }
if ($PSVersionTable.PSVersion.Major -lt 5) { Fail '需要 PowerShell 5.1+' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail '仅支持 Windows x64' }

# ADR-0027：IsInRole 在 UAC 过滤令牌下返回 false，可直接区分未提升/已提升管理员；脚本不申请 UAC。
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Fail '请以管理员身份运行 PowerShell 后重跑本命令（脚本不申请 UAC）'
}

$os = Get-CimInstance Win32_OperatingSystem
$version = [Version]$os.Version
$isServer = [int]$os.ProductType -ne 1
if ($version.Major -lt 10 -or ($isServer -and $version.Build -lt 17763)) {
  Fail "需要 Windows 10/11 或 Windows Server 2019+，当前 $($os.Caption) build $($version.Build)"
}

# 固定机器级安装根：SYSTEM 运行、不依赖用户登录、不写用户 Profile。
$appDir = Join-Path $env:ProgramData 'VCPDeck\Client'
$runtimeRoot = Join-Path $appDir 'runtime\node'

# 在准备 Node.js 前先让 Server 检查开关与 Release readiness，禁用时快速失败。
$preflight = Invoke-RestMethod -Uri "$ServerOrigin/api/client-installer/preflight?platform=win-x64" -TimeoutSec 60

function Test-Node([string]$Path) {
  if (-not $Path -or -not (Test-Path $Path)) { return $false }
  try {
    'process.exit(process.arch === "x64" && Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' | & $Path -
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}
# 0.8.7 之前对安装根使用了不可继承的 ACE，子目录会失去全部 ACE（空 DACL，连管理员也拒绝访问）。
# 空 DACL 需要先 takeown（SeTakeOwnership）才能让 icacls /T 走到深层对象，再重建可继承授权。
function Repair-AppDirAcl {
  & takeown.exe /F $appDir /A /R /D Y 2>$null | Out-Null
  & icacls.exe $appDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C 2>$null | Out-Null
}
function Test-NodeWrite {
  try {
    New-Item -ItemType Directory -Force $runtimeRoot -ErrorAction Stop | Out-Null
    $probe = Join-Path $runtimeRoot ".writeprobe-$PID"
    New-Item -ItemType File -Path $probe -ErrorAction Stop | Out-Null
    Remove-Item -Force $probe
    return $true
  } catch { return $false }
}
$nodeWritable = Test-NodeWrite
if (-not $nodeWritable) { Repair-AppDirAcl; $nodeWritable = Test-NodeWrite }
if (-not $nodeWritable) {
  Fail "无法写入 $runtimeRoot；请以管理员身份执行：takeown /F `"$appDir`" /A /R /D Y; icacls `"$appDir`" /inheritance:r /grant:r `"*S-1-5-18:(OI)(CI)F`" `"*S-1-5-32-544:(OI)(CI)F`" /T /C"
}

# 只复用或下载到机器级私有 runtime；SYSTEM 任务不得依赖机器 PATH 或用户 Node。
$node = Get-ChildItem -Path $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not (Test-Node $node)) {
  $node = $null
  foreach ($base in @('https://npmmirror.com/mirrors/node','https://nodejs.org/dist')) {
    try {
      Write-Host "[vcpdeck] 尝试 Node.js 源: $base"
      $index = Invoke-RestMethod -Uri "$base/index.json" -TimeoutSec 60
      $target = $index | Where-Object { $_.lts -and ([int]($_.version.TrimStart('v').Split('.')[0])) -ge 24 -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
      if (-not $target) { continue }
      $v = $target.version.TrimStart('v')
      $dir = Join-Path $runtimeRoot "node-$v"
      $candidate = Join-Path $dir 'node.exe'
      if (-not (Test-Node $candidate)) {
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "vcpdeck-node-$PID"
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force $tmp | Out-Null
        $archive = "node-v$v-win-x64.zip"
        Invoke-WebRequest -UseBasicParsing -Uri "$base/v$v/$archive" -OutFile (Join-Path $tmp $archive) -TimeoutSec 600
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/v$v/SHASUMS256.txt" -TimeoutSec 60).Content
        $expected = (($sums -split "`n") | Where-Object { $_ -match "  $([regex]::Escape($archive))`r?$" } | Select-Object -First 1).Split(' ')[0]
        $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $archive)).Hash.ToLowerInvariant()
        if (-not $expected -or $actual -ne $expected.ToLowerInvariant()) { Fail 'Node.js SHA-256 校验失败' }
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        Expand-Archive (Join-Path $tmp $archive) $tmp -Force
        Move-Item (Join-Path $tmp "node-v$v-win-x64") $dir
        Remove-Item -Recurse -Force $tmp
      }
      $node = $candidate
      break
    } catch { Write-Warning "Node.js 源失败: $base - $($_.Exception.Message)" }
  }
}
if (-not (Test-Node $node)) { Fail '无法准备 Node.js 24+ x64（国内源和官方源均失败）' }

$tmpInstaller = Join-Path ([IO.Path]::GetTempPath()) "vcpdeck-install-client-$PID.cjs"
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$ServerOrigin$($preflight.installerUrl)" -OutFile $tmpInstaller -TimeoutSec 120
  $actual = (Get-FileHash -Algorithm SHA256 $tmpInstaller).Hash.ToLowerInvariant()
  if ($actual -ne $preflight.installerSha256.ToLowerInvariant()) { Fail '安装器 SHA-256 校验失败' }
  # PSK 只由安装器从 bootstrap 接口获取，bootstrap 脚本不读取也不输出。
  & $node $tmpInstaller "--server-origin=$ServerOrigin" '--platform=win-x64' "--node=$node"
  if ($LASTEXITCODE -ne 0) { Fail "安装器退出码 $LASTEXITCODE" }
} finally { Remove-Item -Force $tmpInstaller -ErrorAction SilentlyContinue }
