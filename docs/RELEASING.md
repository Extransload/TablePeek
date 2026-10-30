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

   파일 이름은 `tablepeek-v0.2.0-<target>.tar.gz`(Windows는 `.zip`)이고, 안에는 `tablepeek-v0.2.0-<target>/` 폴더에 바이너리와 `README.md`(저장소에 `LICENSE`가 생기면 그것도)가 들어간다. 서명·공증은 하지 않는다.
4. **Publish the release**: 아카이브를 모아 `SHA256SUMS`를 만들고, CHANGELOG 절을 노트로 `gh release create`를 실행한다. 태그에 `-`가 있으면 prerelease로 올린다.

끝나면 [Releases](https://github.com/Extransload/TablePeek/releases)에서 파일 여섯 개(아카이브 다섯, `SHA256SUMS`)와 노트를 확인하고, 아카이브 하나를 받아 `./tablepeek --version`과 `./tablepeek serve`로 실행해 본다. 기존 버전을 켠 앱은 하루 안에 새 버전 알림을 띄운다(설정 > 일반 > **지금 확인**으로 바로 볼 수 있다).

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

로컬에서는 현재 플랫폼의 빌드·포장·체크섬·노트 추출과 `actionlint`까지만 확인된다. 다음은 실제 태그로만 확인된다: 다섯 러너(특히 `macos-15-intel`, `ubuntu-24.04-arm`, Windows의 bash·`7z` 포장)에서의 빌드, 아티팩트 주고받기, `gh release create` 권한(`contents: write`), prerelease 표시. 첫 릴리스(v0.1.0)는 워크플로를 끝까지 지켜보고, 실패하면 위 절차대로 태그를 지우고 다시 붙인다. 이후 큰 변경이 있을 때는 `make version V=0.3.0-rc.1`로 프리릴리스를 먼저 내 볼 수 있다.
