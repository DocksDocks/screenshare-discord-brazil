# GoLiveBypass Safe

Fork Windows-only e Tor-only inspirado no [GoLiveBypass](https://github.com/bezumiya/GoLiveBypass), refeito para reduzir os riscos encontrados na auditoria do commit `6af4a3c8a5178effcdeaf392b54e466b8a144753`.

## Instalacao rapida

1. Abra a pagina de [Releases](https://github.com/DocksDocks/screenshare-discord-brazil/releases) e baixe estes tres arquivos na mesma pasta:

- `GoLiveBypassSafe.cer`
- `Trust-GoLiveBypassSafe.ps1`
- **Um** executavel: `GoLiveBypassSafeSetup.exe` ou `GoLiveBypassSafePortable.exe`

Use o **Setup** para a instalacao normal, com atalhos e desinstalador. Use o **Portable** para executar o gerenciador sem instala-lo, principalmente para recuperacao. Se os dois executaveis estiverem na pasta, o comando abaixo usa o Setup.

2. Nessa pasta, clique com o botao direito em uma area vazia e escolha **Abrir no Terminal** ou **Abrir no PowerShell**.
3. Copie e cole todo o bloco abaixo de uma vez:

```powershell
$ErrorActionPreference = "Stop"
$thumb = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"
$cerHash = "D5D0C0EE02D56A38910CF223A55EDFAA28223AFF8AABF54DCD322F0DB6EB078A"
function Assert-NoReparsePoint([string]$ArtifactPath) {
  $current = [IO.Path]::GetFullPath($ArtifactPath)
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Links and junctions are not allowed: $current" }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current = $parent.FullName
  }
}
$cer = (Resolve-Path .\GoLiveBypassSafe.cer).Path
$script = (Resolve-Path .\Trust-GoLiveBypassSafe.ps1).Path
$app = @(".\GoLiveBypassSafeSetup.exe", ".\GoLiveBypassSafePortable.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($null -eq $app) { throw "Setup or Portable executable not found" }
$app = (Resolve-Path -LiteralPath $app).Path
$locks = @()
try {
  foreach ($path in @($cer, $script, $app)) {
    Assert-NoReparsePoint $path
    $locks += [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  }
  foreach ($path in @($cer, $script, $app)) { Assert-NoReparsePoint $path }
  if ((Get-FileHash -LiteralPath $cer -Algorithm SHA256).Hash -ne $cerHash) { throw "Certificate hash mismatch" }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cer)
  if ($cert.Thumbprint -ne $thumb) { throw "Certificate thumbprint mismatch" }
  $sacPath = "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy"
  $sacState = Get-ItemPropertyValue -LiteralPath $sacPath -Name "VerifiedAndReputablePolicyState" -ErrorAction SilentlyContinue
  $needsSacDisable = $sacState -eq 1
  if ($needsSacDisable) {
    Write-Warning "O Smart App Control esta ativo. Desativa-lo reduz a protecao global do Windows."
    if ((Read-Host "Digite DESATIVAR para continuar") -cne "DESATIVAR") { throw "Instalacao cancelada" }
  }
  $addedStores = @()
  try {
    foreach ($store in @("Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")) {
      if (-not (Test-Path -LiteralPath (Join-Path $store $thumb))) {
        Import-Certificate -FilePath $cer -CertStoreLocation $store | Out-Null
        $addedStores += $store
      }
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $script
    if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Thumbprint -ne $thumb) { throw "Trust script signature mismatch" }
    $appSig = Get-AuthenticodeSignature -LiteralPath $app
    if ($appSig.Status -ne "Valid" -or $appSig.SignerCertificate.Thumbprint -ne $thumb) { throw "Executable signature mismatch" }
    if ($needsSacDisable) {
      $disableSac = @'
$ErrorActionPreference = "Stop"
$path = "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy"
$previous = Get-ItemPropertyValue -LiteralPath $path -Name "VerifiedAndReputablePolicyState"
if ($previous -ne 1) { throw "Smart App Control state changed; retry the installation" }
try {
  Set-ItemProperty -LiteralPath $path -Name "VerifiedAndReputablePolicyState" -Value 0
  & "$env:SystemRoot\System32\CiTool.exe" --refresh
  if ($LASTEXITCODE -ne 0) { throw "CiTool failed with exit code $LASTEXITCODE" }
  if ((Get-ItemPropertyValue -LiteralPath $path -Name "VerifiedAndReputablePolicyState") -ne 0) { throw "Smart App Control registry state was not changed" }
} catch {
  $changeFailure = $_.Exception.Message
  try {
    Set-ItemProperty -LiteralPath $path -Name "VerifiedAndReputablePolicyState" -Value $previous
    & "$env:SystemRoot\System32\CiTool.exe" --refresh
    if ($LASTEXITCODE -ne 0) { throw "Rollback refresh failed with exit code $LASTEXITCODE" }
    if ((Get-ItemPropertyValue -LiteralPath $path -Name "VerifiedAndReputablePolicyState") -ne $previous) { throw "Previous registry state was not restored" }
  } catch {
    [Console]::Error.WriteLine("SAC change failed ($changeFailure) and rollback could not be confirmed: $($_.Exception.Message)")
    exit 2
  }
  [Console]::Error.WriteLine("SAC change failed and the previous state was restored: $changeFailure")
  exit 1
}
'@
      $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($disableSac))
      $elevated = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @("-NoProfile", "-EncodedCommand", $encoded)
      $currentSacState = Get-ItemPropertyValue -LiteralPath $sacPath -Name "VerifiedAndReputablePolicyState" -ErrorAction SilentlyContinue
      if ($elevated.ExitCode -eq 2) { throw "Smart App Control change failed and rollback could not be confirmed (current registry state: $currentSacState). Check Windows Security before retrying." }
      if ($elevated.ExitCode -ne 0 -and $currentSacState -eq $sacState) { throw "Smart App Control change failed; the previous registry state remains $currentSacState." }
      if ($elevated.ExitCode -ne 0) { throw "Smart App Control change failed and the registry state changed to $currentSacState. Check Windows Security before retrying." }
      if ($currentSacState -ne 0) { throw "Smart App Control was not disabled (current registry state: $currentSacState). Check Windows Security before retrying." }
    }
    $trustArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -SetupPath `"$app`""
    $trustProcess = Start-Process -FilePath powershell.exe -Wait -PassThru -NoNewWindow -ArgumentList $trustArguments
    if ($trustProcess.ExitCode -ne 0) { throw "Trust script failed with exit code $($trustProcess.ExitCode)" }
  } catch {
    $failure = $_
    $cleanupFailures = @()
    foreach ($store in $addedStores) {
      $trustedCertificate = Join-Path $store $thumb
      Remove-Item -LiteralPath $trustedCertificate -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $trustedCertificate) { $cleanupFailures += $store }
    }
    if ($cleanupFailures.Count -ne 0) { Write-Warning "Nao foi possivel remover a confianca adicionada em: $($cleanupFailures -join ', ')" }
    throw $failure
  }
} finally {
  foreach ($lock in $locks) { $lock.Dispose() }
}
```

4. Se o bloco informar que o Smart App Control esta em `Enforce`, digite `DESATIVAR`.
5. Se exibido, confirme o aviso do Windows para o certificado `GoLiveBypass Safe Private Release`.
6. Confirme o UAC que desativa essa protecao global do Windows, nao apenas para este aplicativo.
7. Quando o gerenciador abrir, clique em **Instalar com backup**. Depois, feche e abra o Discord novamente.

O gerenciador nao precisa ficar aberto. Quando uma atualizacao do Discord criar uma nova pasta `app-VERSAO`, abra o Setup/Portable e clique em **Reparar apos update**.

> O bloco desativa somente o estado `Enforce`; ele nao altera o estado `Evaluation`. Se voce nao quiser reduzir essa protecao global, cancele e nao instale esta release.

## O que muda

- Usa apenas o Tor Expert Bundle oficial e fixado. Nao baixa listas publicas de proxy.
- Roteia `discord.gg` e seus subdominios pelo Tor; os demais hosts continuam diretos.
- A regra PAC nao tem alternativa `DIRECT` para os hosts protegidos.
- Um relay SOCKS local aceita apenas `discord.gg` e subdominios na porta 443, espera o Tor ficar pronto e nao declara sucesso antes de abrir o tunel.
- Nao le token, cookie, usuario, streams, chamadas ou configuracao da conta.
- Recusa `_app.asar`, Vencord, Equicord e qualquer carregador que nao tenha o marcador deste projeto.
- Mantem o original como `app.golive-original.asar`, ainda montavel pelo Electron, e uma segunda copia verificada fora da pasta de versao.
- Registra cada fase da instalacao em um journal duravel e recupera interrupcoes antes de alterar novos arquivos.
- Nao possui auto-updater, bootstrap remoto ou execucao de codigo vindo de `main`.
- Rejeita caminhos absolutos, junctions, links, arquivos nao listados ou entradas que escapem do runtime do Tor.
- Confia em um PID salvo somente quando o executavel correspondente ainda e o `tor.exe` empacotado e possui o listener SOCKS de loopback.
- Carrega o modulo original do Discord somente depois de obter a porta exclusiva do relay; cada tunel revalida o processo e o listener Tor antes e depois da conexao.
- Nao precisa manter o gerenciador aberto: o runtime local inicia com o Discord depois da primeira instalacao.

## Limites

- O projeto modifica o carregador Electron do Discord. Isso nao e uma integracao oficial e pode parar de funcionar apos qualquer atualizacao.
- O botao **Reparar apos update** deve ser executado quando o Discord cria uma nova pasta `app-VERSAO`.
- O projeto recusa instalar quando detecta proxy/PAC do sistema, pois substituir essa politica silenciosamente seria inseguro.
- Tor adiciona latencia ao gateway. Midia, voz e video nao passam pelo Tor.
- Uma falha no Tor deixa o gateway desconectado em vez de usar o IP real.
- O certificado privado desta release nao e emitido por um provedor publico. No estado `Enforce`, o Smart App Control ainda pode bloquear os binarios; nao existe excecao por aplicativo.
- Modificar o cliente pode violar os Termos do Discord. O uso privado nao elimina risco regulatorio ou de conta.

## Desenvolvimento

Requisitos: Windows x64, Node.js 24 e o `tar.exe` incluido no Windows moderno.

```powershell
npm.cmd install
npm.cmd run verify
npm.cmd run prepare:tor
npm.cmd run probe:tor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\new-private-signing-certificate.ps1
npm.cmd run build:private
```

`prepare:tor` baixa somente este artefato:

```text
https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-windows-x86_64-15.0.20.tar.gz
SHA-256 d59bff934e3ad876e1623e24ae60c19aeea56f50178093b9f86fba230639f949
```

O hash corresponde ao `sha256sums-unsigned-build.txt` publicado pelo Tor Project para a versao 15.0.20. O script extrai somente `tor.exe`, GeoIP, configuracao padrao e avisos de licenca. Os transportes plugaveis nao sao empacotados.

`probe:tor` inicia uma instancia temporaria e isolada, aguarda bootstrap completo e valida um handshake TLS autenticado com `gateway.discord.gg` por SOCKS5. Ele nao altera o Discord nem o runtime persistente.

O build privado produz estes arquivos sem versao no nome; a versao continua registrada no binario e na release:

- `release/GoLiveBypassSafeSetup.exe`: instalador por usuario, com atalhos no menu Iniciar e na area de trabalho.
- `release/GoLiveBypassSafePortable.exe`: copia portatil para recuperacao emergencial.
- `release/Trust-GoLiveBypassSafe.ps1`: instalacao de confianca e assinatura verificada.
- `release/GoLiveBypassSafe.cer`: certificado publico, sem chave privada.
- `release/SHA256SUMS.txt`: hashes dos quatro artefatos.

O instalador abre o gerenciador ao terminar, mas o usuario ainda confirma **Instalar com backup**. Ao remover o gerenciador pelo Windows, o desinstalador restaura o Discord primeiro e cancela sua propria remocao se a restauracao falhar. Atualizar apenas o gerenciador nao remove o bypass. Os dados e backups nao sao apagados automaticamente.

O build desativa `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` e argumentos do inspector, exige `app.asar` e habilita a verificacao de integridade ASAR. Os executaveis e o script de confianca sao assinados com o certificado fixado. O `tor.exe` mantem a assinatura e o hash do pacote oficial; o build falha se ele for alterado. Nao ha publicacao automatica nem auto-updater.

## Verificacao

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run probe:tor
npm.cmd run compile
npm.cmd run build:private
```

Os testes cobrem ordenacao de versoes do Discord, instalacao e desinstalacao byte a byte, migracao e restauracao do nome usado pela v0.1.0, recusa de outro modificador, recuperacao em duas fases de falha, a regra PAC sem fallback, o relay SOCKS, confinamento fisico e cobertura exata do manifesto, identidade do processo e do listener Tor, e os pinos do certificado.

## Dados locais

O runtime, journals e backups ficam em `%LOCALAPPDATA%\GoLiveBypassSafe`.

O log `runtime.log` contem somente horario e codigos de estado como `tor_started`, `tor_ready`, `gateway_routed`, `route_ready` e `route_blocked`. Nao registra URLs, proxies, conta ou sessao.

## Assinatura e Smart App Control

As releases usam um certificado RSA autoassinado. A chave privada nao e exportavel e permanece somente no computador do mantenedor; a release publica contem apenas o certificado publico.

```text
Certificado SHA-1: 4960FAD2932D56589F1DADFF3CBEE143FAA9EB35
Arquivo CER SHA-256: D5D0C0EE02D56A38910CF223A55EDFAA28223AFF8AABF54DCD322F0DB6EB078A
```

O comando de instalacao autentica esses valores, importa o certificado exato em `CurrentUser\Root` e `CurrentUser\TrustedPublisher`, valida a assinatura do `.ps1` e somente depois o executa. Compare os valores acima por outro canal confiavel antes da primeira instalacao.

Esta assinatura autoassinada, embora validada localmente, foi bloqueada pelo Smart App Control em estado `Enforce`. O Windows nao oferece uma excecao por aplicativo; para continuar com este fluxo quando houver esse bloqueio, e necessario desativa-lo globalmente.

O bloco rejeita links e junctions nos arquivos e em seus caminhos. Para arquivos regulares, ele mantem handles que impedem gravacao e exclusao desde a autenticacao ate o fim da execucao. Depois da confirmacao e das verificacoes, ele inicia um PowerShell elevado, confirma novamente que o estado ainda e `Enforce`, define `VerifiedAndReputablePolicyState` como `0` e executa `CiTool.exe --refresh`, conforme o procedimento documentado pela [Microsoft para desativar o Smart App Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol). Se a mudanca falhar, ele tenta restaurar e verificar o estado anterior; se nao conseguir confirmar o rollback ou a remocao da confianca adicionada, encerra com um erro e orienta conferir o Windows Security antes de tentar novamente. A confianca adicionada por essa tentativa e removida se o script ou o executavel terminar com erro; ela permanece disponivel para reparo e desinstalacao somente depois de uma conclusao bem-sucedida. Tambem e possivel alterar o SAC em **Seguranca do Windows > Controle de aplicativos e navegador > Smart App Control**. Segundo a [FAQ da Microsoft](https://support.microsoft.com/en-us/windows/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003), atualizacoes recentes permitem reativa-lo depois; ao reativar, o Windows pode voltar a bloquear o Setup, o Portable e o script desta release.

O desinstalador restaura o Discord, mas nao remove silenciosamente uma decisao de confianca do Windows. Depois de desinstalar, valide novamente a assinatura do script e remova o certificado com:

```powershell
$thumb = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"
$sig = Get-AuthenticodeSignature .\Trust-GoLiveBypassSafe.ps1
if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Thumbprint -ne $thumb) { throw "Trust script signature mismatch" }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Trust-GoLiveBypassSafe.ps1 -RemoveTrust
```

Enquanto esse certificado permanecer confiavel, qualquer codigo futuro assinado pela mesma chave privada tambem sera aceito para esse usuario. Remova-o quando nao precisar mais das releases.

## Licenca

Este trabalho e uma versao modificada, datada de 23 de agosto de 2026, baseada no mecanismo publicado pelo projeto GoLiveBypass. Ele e distribuido sob GNU GPL v3, sem garantia. Consulte `LICENSE` e `THIRD_PARTY_NOTICES.md`.
