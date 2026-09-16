param([Parameter(Mandatory=$true)][string]$ServerOrigin)
$ErrorActionPreference = 'Stop'
$ServerOrigin = $ServerOrigin.TrimEnd('/')
function Fail([string]$Message) { throw "[vcpdeck] $Message" }
if ($PSVersionTable.PSVersion.Major -lt 5) { Fail '需要 PowerShell 5.1+' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail '仅支持 Windows x64' }

# ADR-0027：必须在用户主动提升的本机管理员 PowerShell 中运行；脚本绝不调用 Start-Process -Verb RunAs 申请 UAC。
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$isHighIntegrity = @($identity.Groups | Where-Object { $_.Value -match '^S-1-16-(12288|16384)$' }).Count -gt 0
if (-not $isAdmin -or -not $isHighIntegrity) {
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
# 优先复用已就绪的机器级私有 runtime，其次机器级 PATH 中可用的 Node 24+，最后下载到私有 runtime。
$node = Get-ChildItem -Path $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not (Test-Node $node)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not (Test-Node $node)) {
  New-Item -ItemType Directory -Force $runtimeRoot | Out-Null
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
