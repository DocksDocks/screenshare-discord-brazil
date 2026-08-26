# GoLiveBypass Safe

Fork Windows-only e Tor-only inspirado no [GoLiveBypass](https://github.com/bezumiya/GoLiveBypass), refeito para reduzir os riscos encontrados na auditoria do commit `6af4a3c8a5178effcdeaf392b54e466b8a144753`.

## Instalacao rapida

1. Abra a pagina de [Releases](https://github.com/DocksDocks/screenshare-discord-brazil/releases) e baixe `GoLiveBypassSafe-v0.2.3.zip`.
2. Compare o SHA-256 exibido pelo GitHub, extraia todo o ZIP para uma pasta e confira os arquivos com `SHA256SUMS.txt`.
3. Execute `Install-GoLiveBypassSafe.bat` normalmente, sem **Executar como administrador**.
4. Confirme somente o UAC do helper `Sac-GoLiveBypassSafe.ps1` quando ele for exibido. O Setup e o gerenciador continuam sem elevacao.

Como alternativa ao ZIP, baixe `Install-GoLiveBypassSafe.bat`, `GoLiveBypassSafe.cer`, `Trust-GoLiveBypassSafe.ps1`, `Sac-GoLiveBypassSafe.ps1`, `GoLiveBypassSafeSetup.exe` e `GoLiveBypassSafePortable.exe` na mesma pasta. `SOURCE.txt` e `SHA256SUMS.txt` servem para proveniencia e verificacao; os archives **Source code** gerados pelo GitHub nao sao instaladores.

Executar o BAT deliberadamente constitui o consentimento para o fluxo. Nao ha confirmacao digitada nem clique no gerenciador: o controller assinado instala o Setup em modo silencioso e executa o Portable com `--install-and-exit`.

O controller valida hashes e assinaturas fixados, mantem locks de leitura sobre os artefatos e registra o estado SAC anterior. Quando o estado era `Enforce`, um mutex nomeado por tentativa impede o helper de restaura-lo durante Setup, manager ou limpeza de falha; se o controller cair, o Windows libera essa posse abandonada para o helper continuar a restauracao. O helper elevado so confirma o `COMMIT` depois de restaurar o SAC anterior, executar `CiTool.exe --refresh` e consultar a politica efetivamente aplicada com `CiTool.exe --list-policies`. Falha, cancelamento ou timeout encerra e confirma a saida da arvore do processo usando handles vinculados a PID e horario de criacao, restaura o Discord e remove o manager quando ele foi criado pela tentativa. A tentativa tambem remove somente a confianca que ela propria adicionou. O codigo `GOLIVE_AUTOMATION_ROLLBACK_UNCONFIRMED` identifica separadamente a restauracao nao confirmada de aplicativo, SAC ou confianca e exige conferir o Windows Security e o Discord antes de tentar novamente.

Quando o estado anterior e `Enforce`, ele fica em `Off` somente durante Setup e manager e volta para `Enforce` antes da confirmacao de sucesso. `Evaluation`, `Off` e valor ausente permanecem inalterados.

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
- Execute novamente o BAT ou use **Reparar apos update** quando o Discord cria uma nova pasta `app-VERSAO`.
- O projeto recusa instalar quando detecta proxy/PAC do sistema, pois substituir essa politica silenciosamente seria inseguro.
- Tor adiciona latencia ao gateway. Midia, voz e video nao passam pelo Tor.
- Uma falha no Tor deixa o gateway desconectado em vez de usar o IP real.
- O certificado privado desta release nao e emitido por um provedor publico. No estado `Enforce`, o Smart App Control ainda pode bloquear os binarios; nao existe excecao por aplicativo.
- Modificar o cliente pode violar os Termos do Discord. O uso privado nao elimina risco regulatorio ou de conta.

## Desenvolvimento

Requisitos: Windows x64, Node.js 24, npm 11.16.0 e o `tar.exe` incluido no Windows moderno.

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
- `release/Install-GoLiveBypassSafe.bat`: launcher automatico sem elevacao.
- `release/Trust-GoLiveBypassSafe.ps1`: controller assinado e vinculado aos hashes da release.
- `release/Sac-GoLiveBypassSafe.ps1`: unico helper elevado, assinado e limitado ao SAC.
- `release/GoLiveBypassSafe.cer`: certificado publico, sem chave privada.
- `release/SOURCE.txt`: versao, commit e estado `release` ou `development` vinculados ao controller assinado.
- `release/SHA256SUMS.txt`: hashes dos sete artefatos.
- `release/GoLiveBypassSafe-v0.2.3.zip`: pacote unico com os oito arquivos anteriores.

O BAT instala o Setup silenciosamente e executa o Portable em modo headless. Ao remover o gerenciador pelo Windows, o desinstalador restaura o Discord primeiro e cancela sua propria remocao se a restauracao falhar. Atualizar apenas o gerenciador nao remove o bypass. Os dados e backups nao sao apagados automaticamente.

O build desativa `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` e argumentos do inspector, exige `app.asar` e habilita a verificacao de integridade ASAR. Ele exige versoes sincronizadas, npm 11.16.0, arvore limpa e tag anotada para uma release; `-AllowDirty` produz somente um build local marcado como `development`. O pipeline reinstala exatamente o `package-lock.json` com a politica estrita de scripts e overrides perigosos desativados, permitindo somente o script de instalacao do Electron declarado em `package.json`, limpa saidas antigas, executa `verify`, confere versao, assinaturas, fuses, toda a arvore runtime/Tor e a imutabilidade do source ate o fim da assinatura, e vincula commit e hashes ao controller assinado. O ZIP usa ordem e horario fixos e cada entrada e reaberta e comparada por SHA-256 com seu artefato de origem. Nao ha publicacao automatica nem auto-updater.

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

O controller autentica esses valores, importa o certificado exato em `CurrentUser\Root` e `CurrentUser\TrustedPublisher`, valida as assinaturas e exige os hashes exatos de Setup, Portable e helper injetados durante o build. Compare os valores acima por outro canal confiavel antes da primeira instalacao.

Esta assinatura autoassinada, embora validada localmente, foi bloqueada pelo Smart App Control em estado `Enforce`. O Windows nao oferece uma excecao por aplicativo. Atualizacoes recentes permitem desativar o SAC temporariamente e ativa-lo novamente sem reinstalar o Windows, conforme a [FAQ atual da Microsoft](https://support.microsoft.com/en-us/windows/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003).

O controller rejeita links e junctions e mantem handles de leitura desde a autenticacao ate o fim. Somente o supervisor assinado e elevado. Ele confirma novamente o estado configurado e a politica SAC efetivamente aplicada, altera temporariamente apenas `Enforce` para `Off` e executa `CiTool.exe --refresh`, conforme o procedimento documentado pela [Microsoft para o Smart App Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol). A confirmacao efetiva exige `VerifiedAndReputableDesktop` ou `VerifiedAndReputableDesktopEvaluation` com `IsEnforced` no resultado de `CiTool.exe --list-policies --json`. Setup e manager sao filhos do controller sem elevacao. Antes de confirmar sucesso, e tambem em falha, timeout ou perda do canal, o supervisor restaura e verifica o estado anterior. A matriz real deve ser validada apenas em VMs descartaveis com SAC. A confianca adicionada permanece somente depois de sucesso. Tambem e possivel alterar o SAC em **Seguranca do Windows > Controle de aplicativos e navegador > Smart App Control**.

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
