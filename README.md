# GoLiveBypass Safe

Fork Windows-only e Tor-only inspirado no [GoLiveBypass](https://github.com/bezumiya/GoLiveBypass), refeito para reduzir os riscos encontrados na auditoria do commit `6af4a3c8a5178effcdeaf392b54e466b8a144753`.

## Instalacao rapida

1. Abra a pagina de [Releases](https://github.com/DocksDocks/screenshare-discord-brazil/releases) e baixe `GoLiveBypassSafe-v0.2.5.zip`.
2. Compare o SHA-256 exibido pelo GitHub e extraia todo o ZIP para uma pasta.
3. Em **Seguranca do Windows > Controle de aplicativos e navegador > Smart App Control**, selecione **Desativado**.
4. Se uma versao anterior estiver instalada, abra o manager, restaure o Discord e desinstale essa versao antes de continuar.
5. Execute `Install-GoLiveBypassSafe.bat` normalmente, sem **Executar como administrador**.
6. Depois de `GOLIVE_AUTOMATION_OK`, volte ao Windows Security e ligue novamente o Smart App Control.

O controller recusa iniciar enquanto o Smart App Control estiver em `Enforce` ou `Evaluation`. Ele nao altera o registro do SAC, nao solicita UAC e nao instala certificados. Em sistemas nos quais o SAC nao esta disponivel, nenhuma alteracao e necessaria.

Somente o ZIP deterministico e publicado como asset da release. Os archives **Source code** gerados automaticamente pelo GitHub nao sao instaladores. O hash do proprio ZIP, obtido pela pagina da release ou por outro canal confiavel, e a fronteira de autenticidade; `SHA256SUMS.txt` confere os arquivos depois da extracao, mas nao substitui essa verificacao externa.

Executar o BAT deliberadamente constitui consentimento para o fluxo. O controller valida os hashes fixados do Setup e da arvore completa do manager, rejeita links e junctions, impede duas instalacoes simultaneas e mantem locks de leitura durante a execucao. Falha ou timeout so permite restauracao depois de confirmar a saida da arvore de processos. O Discord e restaurado quando necessario, mas o manager instalado fica preservado para recuperacao ou desinstalacao manual. `GOLIVE_AUTOMATION_ROLLBACK_UNCONFIRMED` exige conferir o Discord antes de tentar novamente.

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
- Os executaveis e scripts nao sao assinados. O Smart App Control precisa permanecer desligado durante instalacao, reparo e desinstalacao, e deve ser ligado manualmente depois.
- Modificar o cliente pode violar os Termos do Discord. O uso privado nao elimina risco regulatorio ou de conta.

## Desenvolvimento

Requisitos: Windows x64, Node.js 24.18.0, npm 11.16.0 e o `tar.exe` incluido no Windows moderno.

```powershell
npm.cmd ci --strict-allow-scripts=true --dangerously-allow-all-scripts=false --ignore-scripts=false
npm.cmd run verify
npm.cmd run prepare:tor
npm.cmd run probe:tor
npm.cmd run build:release
```

`prepare:tor` baixa somente este artefato:

```text
https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-windows-x86_64-15.0.20.tar.gz
SHA-256 d59bff934e3ad876e1623e24ae60c19aeea56f50178093b9f86fba230639f949
```

O hash corresponde ao `sha256sums-unsigned-build.txt` publicado pelo Tor Project para a versao 15.0.20. O script extrai somente `tor.exe`, GeoIP, configuracao padrao e avisos de licenca. Os transportes plugaveis nao sao empacotados.

`probe:tor` inicia uma instancia temporaria e isolada, aguarda bootstrap completo e valida um handshake TLS autenticado com `gateway.discord.gg` por SOCKS5. Ele nao altera o Discord nem o runtime persistente.

## Release

O build publica somente `release/GoLiveBypassSafe-v0.2.5.zip`, contendo:

- `GoLiveBypassSafeSetup.exe`: instalador NSIS por usuario.
- `Install-GoLiveBypassSafe.bat`: launcher sem elevacao.
- `Install-GoLiveBypassSafe.ps1`: controller com os hashes fixados da release.
- `SOURCE.txt`: versao, commit e estado `release` ou `development`.
- `SHA256SUMS.txt`: hashes dos quatro artefatos anteriores.

O Setup usa um destino local fixo e o controller confirma esse destino pela chave NSIS. A arvore completa instalada, exceto o desinstalador que nao e executado pelo rollback automatico, precisa corresponder ao hash do build antes de o manager rodar. Uma arvore da mesma release pode ser reutilizada para reparo; versoes anteriores e estados incompletos precisam ser desinstalados primeiro, evitando que o Setup execute um desinstalador antigo nao autenticado. Em uma falha, o mesmo manager autenticado restaura o Discord e a instalacao permanece disponivel para recuperacao; nenhum processo de falha apaga automaticamente executaveis, registros ou atalhos. O desinstalador normal restaura o Discord antes de remover o manager e aborta se isso falhar.

O pipeline reinstala exatamente o `package-lock.json`, executa `verify`, confere versao, fuses Electron, runtime/Tor, procedencia e o conjunto final de artefatos. O ZIP usa ordem e horario fixos e cada entrada e reaberta e comparada por SHA-256. `build:release` exige arvore limpa e tag anotada em `HEAD`; `-AllowDirty` gera somente build local marcado como `development`.

`.github/workflows/ci.yml` verifica pushes e pull requests com permissao somente de leitura. `.github/workflows/release.yml` reage a tags anotadas `vX.Y.Z`: um job somente leitura gera o ZIP e um runner novo, com permissao de publicacao, baixa o artifact, revalida hash e identidade remota da tag, atualiza ou cria uma release draft retomavel e so a publica depois de comparar nome, tamanho e digest do unico asset. As actions sao fixadas por SHA e nenhum secret externo e necessario.

## Verificacao

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run probe:tor
npm.cmd run compile
npm.cmd run build:release
```

Os testes cobrem ordenacao de versoes do Discord, instalacao e desinstalacao byte a byte, migracao e restauracao do nome usado pela v0.1.0, recusa de outro modificador, recuperacao em duas fases de falha, regra PAC sem fallback, relay SOCKS, confinamento fisico, identidade de processos, hashes do pacote e invariantes dos workflows.

## Dados locais

O runtime, journals e backups ficam em `%LOCALAPPDATA%\GoLiveBypassSafe`.

O log `runtime.log` contem somente horario e codigos de estado como `tor_started`, `tor_ready`, `gateway_routed`, `route_ready` e `route_blocked`. Nao registra URLs, proxies, conta ou sessao.

## Certificado antigo

A `v0.2.5` nao usa nem instala certificados. Quem executou a `v0.2.4` pode remover a confianca antiga pelo thumbprint exato:

```powershell
$thumb = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"
foreach ($store in @("Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")) {
  $entry = Join-Path $store $thumb
  if (Test-Path -LiteralPath $entry) { Remove-Item -LiteralPath $entry -Force }
}
```

## Licenca

Este trabalho e uma versao modificada, datada de 23 de agosto de 2026, baseada no mecanismo publicado pelo projeto GoLiveBypass. Ele e distribuido sob GNU GPL v3, sem garantia. Consulte `LICENSE` e `THIRD_PARTY_NOTICES.md`.
