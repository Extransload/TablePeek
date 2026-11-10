# 릴리스 절차

TablePeek 관리자가 새 버전을 내는 방법. 버전은 [SemVer](https://semver.org)를 따르고 v0.1.0에서 시작한다. 0.x 동안은 기능 추가가 minor(0.1.0 → 0.2.0), 버그 수정만 있으면 patch(0.1.0 → 0.1.1)를 올린다.

## 버전이 적힌 곳

| 파일 | 내용 |
|---|---|
| `Cargo.toml` `[workspace.package] version` | 유일한 원본. 모든 crate가 `version.workspace = true`로 따른다 |
| `web/package.json`, `web/package-lock.json` | 같은 번호. `make check`(그리고 CI)가 다르면 실패한다 |
| `Cargo.lock` | workspace crate 네 개의 버전. `make version`이 함께 갱신한다 |
| `CHANGELOG.md` | [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 형식. `## [x.y.z] - YYYY-MM-DD` 절이 그대로 릴리스 노트가 된다 |

바이너리는 빌드할 때 커밋(`TABLEPEEK_COMMIT`)과 빌드 종류(`TABLEPEEK_DIST`, 릴리스 워크플로는 `release`, 그 밖은 `source`)를 넣는다. `tablepeek --version`은 `tablepeek 0.1.0 (abc1234, release)`처럼, `GET /api/version`은 `{version, commit, dist}`로 보여 준다.

## 1. 버전 올리기

`main`이 깨끗하고 CI가 통과한 상태에서:

```sh
make version V=0.2.0
```

이 명령은 git을 건드리지 않고 다음만 한다.

- `Cargo.toml`, `web/package.json`, `web/package-lock.json`의 버전을 바꾼다.
- `CHANGELOG.md`에 오늘 날짜로 빈 `## [0.2.0] - YYYY-MM-DD` 절을 `[Unreleased]` 바로 아래(직전 버전 절 위)에 넣고, 맨 아래 비교 링크(`[Unreleased]`, `[0.2.0]`)를 고친다.
- `cargo update --workspace --offline`으로 `Cargo.lock`의 workspace crate 버전을 맞춘다.

프리릴리스는 `make version V=0.2.0-rc.1`처럼 붙인다. 태그도 `v0.2.0-rc.1`이 되고, GitHub에는 prerelease로 올라가며 앱의 새 버전 알림은 이를 무시한다.

## 2. CHANGELOG 채우기

`[Unreleased]` 아래 쌓인 항목을 새 절로 옮기고 `Added` / `Changed` / `Fixed` / `Removed` / `Security` 제목 아래 정리한다. 사용자 눈에 보이는 변화만 쓴다. 절이 비어 있으면 릴리스 워크플로가 첫 단계에서 실패한다. 미리 확인하려면:

```sh
node scripts/version.mjs notes 0.2.0     # 릴리스 노트로 올라갈 내용
make check                               # 버전 일치, 포맷, 빌드, 타입 검사
```

날짜는 `make version`을 실행한 날이다. 태그를 다른 날 붙이면 제목의 날짜를 그날로 고친다.

## 3. 커밋하고 태그 붙이기

```sh
git add Cargo.toml Cargo.lock web/package.json web/package-lock.json CHANGELOG.md
git commit -m "Release 0.2.0"
git push origin main
git tag -a v0.2.0 -m "TablePeek 0.2.0"
git push origin v0.2.0
```

태그는 `main`에 올라간 릴리스 커밋에 붙인다. 태그 이름의 버전과 `Cargo.toml`의 버전이 다르면 워크플로가 바로 멈춘다.

## 4. 워크플로 확인

태그를 밀면 `.github/workflows/release.yml`이 돈다(저장소 Actions 탭의 **Release**).

1. **Tag matches the version**: `node scripts/version.mjs tag v0.2.0`으로 태그와 세 파일의 버전을 비교하고, CHANGELOG 절이 있는지 본다.
2. **Web bundle**: `web/dist`를 한 번 빌드해 아티팩트로 넘긴다.
3. **Build <target>**: 다섯 플랫폼을 각자의 러너에서 `TABLEPEEK_DIST=release cargo build --release --locked`로 빌드하고, `--version`이 `tablepeek 0.2.0 (…, release)`인지 확인한 뒤 `scripts/package.sh archive`로 묶는다.

   | target | 러너 | 아카이브 |
   |---|---|---|
   | `aarch64-apple-darwin` | `macos-15` | `.tar.gz` |
   | `x86_64-apple-darwin` | `macos-15-intel` | `.tar.gz` |
   | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` | `.tar.gz` |
   | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | `.tar.gz` |
   | `x86_64-pc-windows-msvc` | `windows-latest` | `.zip` |

   파일 이름은 `tablepeek-v0.2.0-<target>.tar.gz`(Windows는 `.zip`)이고, 안에는 `tablepeek-v0.2.0-<target>/` 폴더에 바이너리와 `README.md`, `LICENSE`(AGPL-3.0)가 들어간다. 서명·공증은 하지 않는다.
4. **Desktop <target>**: 데스크톱 앱(`crates/tablepeek-desktop`)을 세 러너에서 `TABLEPEEK_DIST=desktop`으로 `npx --yes @tauri-apps/cli@2.12.4 build --ci --target <target> --bundles …`로 묶고, `scripts/package.sh desktop`이 릴리스 이름으로 옮긴다. 버전은 `Cargo.toml`의 workspace 버전을 그대로 쓴다(`tauri.conf.json`에는 버전을 적지 않는다).

   | target | 러너 | 파일 |
   |---|---|---|
   | `aarch64-apple-darwin` | `macos-15` | `TablePeek-v0.2.0-<target>.dmg`, `TablePeek-v0.2.0-<target>.app.tar.gz`(+`.sig`) |
   | `x86_64-apple-darwin` | `macos-15-intel` | 위와 같음 |
   | `x86_64-pc-windows-msvc` | `windows-latest` | `TablePeek-v0.2.0-<target>-setup.exe`(NSIS, +`.sig`) |

   유료 코드 서명은 하지 않는다. macOS는 ad-hoc 서명(`signingIdentity: "-"`)만, Windows는 서명 없음(사용자 첫 실행 안내는 README). 대신 업데이터 묶음(`.app.tar.gz`, `-setup.exe`)은 Tauri 업데이터 키(minisign)로 서명해 `.sig`를 만든다. 이 단계에 저장소 Secrets 두 개가 필요하다.

   | Secret | 값 |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | 개인 키 파일의 **내용**(`~/.tauri/tablepeek-updater.key`를 그대로 붙여 넣는다) |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 키 비밀번호. 지금 키는 빈 비밀번호라 비워 두거나 만들지 않아도 된다 |

   공개 키는 `crates/tablepeek-desktop/tauri.conf.json`의 `plugins.updater.pubkey`에 있다. 키를 잃으면 이미 설치된 앱은 새 업데이트를 받을 수 없으므로(서명이 맞지 않는다) 개인 키는 저장소 밖에 백업해 둔다. 키를 바꾸면 그 뒤 릴리스부터는 사용자가 한 번 손으로 내려받아 설치해야 한다.
5. **Publish the release**: 아카이브와 데스크톱 파일을 모아 `SHA256SUMS`(아카이브, `.dmg`, `.app.tar.gz`, `-setup.exe`)를 만들고, `node scripts/latest-json.mjs v0.2.0 dist --notes notes.md`로 업데이터 매니페스트 `latest.json`(버전, 노트, `pub_date`, `darwin-aarch64`·`darwin-x86_64`·`windows-x86_64` 각각의 `.sig` 내용과 다운로드 URL)을 쓴 뒤, CHANGELOG 절을 노트로 `gh release create`를 실행한다. 태그에 `-`가 있으면 prerelease로 올린다. 앱은 `https://github.com/Extransload/TablePeek/releases/latest/download/latest.json`을 읽으므로 prerelease는 앱 업데이트로 나가지 않는다.
6. **Update the Homebrew cask**: 안정 태그(`-` 없음)에서만 돈다. 두 Mac의 `.dmg`로 `node scripts/homebrew-cask.mjs v0.2.0 dist`가 cask(버전, 아키텍처별 `sha256`, 설치 후 quarantine을 지우는 `postflight_steps`)를 쓰고, [Extransload/homebrew-tap](https://github.com/Extransload/homebrew-tap)의 `Casks/tablepeek.rb`로 커밋해 민다. 탭 저장소에는 이 저장소의 secret `HOMEBREW_TAP_DEPLOY_KEY`(탭에만 쓰기 권한이 있는 deploy key의 개인 키)로 들어간다. 키를 바꾸려면 `ssh-keygen -t ed25519`로 새로 만들어 공개 키를 `gh repo deploy-key add … -R Extransload/homebrew-tap --allow-write`로, 개인 키를 `gh secret set HOMEBREW_TAP_DEPLOY_KEY`로 넣고 옛 deploy key를 지운다. 사용자는 `brew install --cask extransload/tap/tablepeek`로 설치한다. 탭의 `Check casks` 워크플로가 밀린 cask에 `brew style`과 `brew audit --online`을 돌린다.

끝나면 [Releases](https://github.com/Extransload/TablePeek/releases)에서 아카이브 다섯, `.dmg` 둘, `.app.tar.gz`와 `-setup.exe`(각각 `.sig`), `latest.json`, `SHA256SUMS`와 노트를 확인하고, 아카이브 하나를 받아 `./tablepeek --version`과 `./tablepeek serve`로 실행해 본다. 기존 버전을 켠 앱은 하루 안에 새 버전 알림을 띄운다(설정 > 일반 > **지금 확인**으로 바로 볼 수 있다). 데스크톱 앱은 새 버전을 스스로 내려받아 위쪽 바에 **다시 시작해서 업데이트**를 띄우므로, 그것을 눌러 새 버전이 깔리고 다시 열리는지 본다.

로컬에서 같은 포장 단계를 미리 돌려 보려면(현재 플랫폼만):

```sh
make web
TABLEPEEK_DIST=release cargo build --release --locked -p tablepeek --target aarch64-apple-darwin
scripts/package.sh archive v0.2.0 aarch64-apple-darwin target/aarch64-apple-darwin/release/tablepeek /tmp/tp-dist
scripts/package.sh sums /tmp/tp-dist
node scripts/version.mjs notes 0.2.0
```

## 5. 실패했을 때

**빌드 전에 실패(태그 불일치, CHANGELOG 누락).** 아직 릴리스는 만들어지지 않았다. 태그를 지우고 고친 커밋에 다시 붙인다.

```sh
git push origin :refs/tags/v0.2.0     # 원격 태그 삭제
git tag -d v0.2.0                     # 로컬 태그 삭제
# 고쳐서 main에 커밋하고 push한 뒤
git tag -a v0.2.0 -m "TablePeek 0.2.0"
git push origin v0.2.0
```

**한 플랫폼만 일시적으로 실패(러너 문제, 네트워크).** Actions에서 그 실행의 **Re-run failed jobs**를 누른다. 실패한 빌드가 다시 성공하면 이어서 릴리스 단계가 돈다.

**코드 문제로 빌드 실패.** 위처럼 태그를 지우고, 수정을 `main`에 넣은 뒤 같은 태그를 새 커밋에 다시 붙인다. 아직 아무도 받지 않은 버전이므로 번호를 그대로 써도 된다.

**릴리스가 이미 올라간 뒤 문제가 발견됨.** 받은 사람이 있을 수 있으므로 같은 번호를 다시 쓰지 않는다. 수정하고 patch 버전(0.2.1)으로 새로 낸다. 잘못된 릴리스는 지우거나 노트에 경고를 단다.

**릴리스 단계만 실패했는데 릴리스가 반쯤 만들어짐.** `gh release create`는 같은 태그의 릴리스가 있으면 실패한다. 남은 릴리스를 지우고(`gh release delete v0.2.0 --yes`, 태그는 남긴다) 그 실행의 **Re-run failed jobs**를 누른다.

## 태그를 밀어야만 확인되는 것

로컬에서는 현재 플랫폼의 빌드·포장·체크섬·노트 추출과 `actionlint`까지만 확인된다. 데스크톱 앱은 이 Mac에서 `make desktop-bundle`(또는 `cd crates/tablepeek-desktop && npx --yes @tauri-apps/cli@2.12.4 build --debug --bundles app`)로 묶어 볼 수 있고, 업데이트는 `--config '{"plugins":{"updater":{"endpoints":["http://127.0.0.1:<port>/latest.json"],"dangerousInsecureTransportProtocol":true}}}'`로 엔드포인트만 바꾼 빌드와 `scripts/latest-json.mjs … --base-url http://127.0.0.1:<port> --platforms darwin-aarch64`로 만든 매니페스트를 로컬 서버로 내놓아 시험할 수 있다(앱은 심볼릭 링크가 아닌 경로에서 실행해야 한다. macOS의 `/tmp` 대신 `/private/tmp`). 다음은 실제 태그로만 확인된다: 다섯 러너(특히 `macos-15-intel`, `ubuntu-24.04-arm`, Windows의 bash·`7z` 포장)에서의 빌드, 데스크톱 세 러너의 Tauri 빌드(Windows NSIS, `macos-15-intel`의 x64 앱, CI에서의 `.dmg` 만들기), Secrets로 한 업데이터 서명, 아티팩트 주고받기, `gh release create` 권한(`contents: write`), `releases/latest/download/latest.json` 경로로 실제 업데이트가 받아지는지(Windows 설치 프로그램이 앱을 다시 여는지 포함), prerelease 표시. 첫 릴리스(v0.1.0)는 워크플로를 끝까지 지켜보고, 실패하면 위 절차대로 태그를 지우고 다시 붙인다. 이후 큰 변경이 있을 때는 `make version V=0.3.0-rc.1`로 프리릴리스를 먼저 내 볼 수 있다.
