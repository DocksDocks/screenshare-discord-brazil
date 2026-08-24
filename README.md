# GoLiveBypass Safe

Fork Windows-only e Tor-only inspirado no [GoLiveBypass](https://github.com/bezumiya/GoLiveBypass), refeito para reduzir os riscos encontrados na auditoria do commit `6af4a3c8a5178effcdeaf392b54e466b8a144753`.

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
- O certificado privado desta release nao e emitido por um provedor publico. Com o Smart App Control ativo, o Windows ainda pode bloquear os binarios; nao existe excecao por aplicativo.
- Modificar o cliente pode violar os Termos do Discord. O uso privado nao elimina risco regulatorio ou de conta.

## Release privada assinada

As releases privadas usam um certificado RSA autoassinado. A chave privada nao e exportavel e permanece somente no repositario de certificados do mantenedor; a release contem apenas o certificado publico.

```text
Certificado SHA-1: 4960FAD2932D56589F1DADFF3CBEE143FAA9EB35
Arquivo CER SHA-256: D5D0C0EE02D56A38910CF223A55EDFAA28223AFF8AABF54DCD322F0DB6EB078A
```

Antes da primeira instalacao, compare esses valores por um canal confiavel. O comando abaixo autentica o certificado publico fixado, pede sua importacao explicita e verifica a assinatura do script antes de executa-lo com `ExecutionPolicy Bypass`.

O Smart App Control considera apenas certificados de provedores confiaveis. Se ele bloquear esta release privada, desative-o em **Seguranca do Windows > Controle de aplicativos e navegador > Smart App Control**. Versoes atuais do Windows permitem ativa-lo novamente, mas nao oferecem liberacao para um unico aplicativo.

Depois de baixar `GoLiveBypassSafeSetup.exe`, `GoLiveBypassSafe.cer` e `Trust-GoLiveBypassSafe.ps1` na mesma pasta, execute:

```powershell
$thumb = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"; $cerHash = "D5D0C0EE02D56A38910CF223A55EDFAA28223AFF8AABF54DCD322F0DB6EB078A"; if ((Get-FileHash .\GoLiveBypassSafe.cer -Algorithm SHA256).Hash -ne $cerHash) { throw "Certificate hash mismatch" }; $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path .\GoLiveBypassSafe.cer).Path); if ($cert.Thumbprint -ne $thumb) { throw "Certificate thumbprint mismatch" }; foreach ($store in @("Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")) { if (-not (Test-Path (Join-Path $store $thumb))) { Import-Certificate .\GoLiveBypassSafe.cer -CertStoreLocation $store | Out-Null } }; $sig = Get-AuthenticodeSignature .\Trust-GoLiveBypassSafe.ps1; if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Thumbprint -ne $thumb) { throw "Trust script signature mismatch" }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Trust-GoLiveBypassSafe.ps1
```

O script confere o hash e o thumbprint, pede a confirmacao explicita do Windows para instalar o certificado autoassinado exato em `CurrentUser\Root`, tambem o adiciona a `CurrentUser\TrustedPublisher`, valida sua propria assinatura e a do instalador, e so entao inicia a instalacao. A chave privada nunca e distribuida.

O desinstalador restaura o Discord, mas nao remove silenciosamente uma decisao de confianca do Windows. Depois de desinstalar e usando o mesmo script autenticado acima, remova o certificado com:

```powershell
$thumb = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"; $sig = Get-AuthenticodeSignature .\Trust-GoLiveBypassSafe.ps1; if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Thumbprint -ne $thumb) { throw "Trust script signature mismatch" }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Trust-GoLiveBypassSafe.ps1 -RemoveTrust
```

Enquanto esse certificado permanecer confiavel, qualquer codigo futuro assinado pela mesma chave privada tambem sera aceito para esse usuario. Remova-o quando nao precisar mais de releases privadas.

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

## Licenca

Este trabalho e uma versao modificada, datada de 23 de agosto de 2026, baseada no mecanismo publicado pelo projeto GoLiveBypass. Ele e distribuido sob GNU GPL v3, sem garantia. Consulte `LICENSE` e `THIRD_PARTY_NOTICES.md`.
