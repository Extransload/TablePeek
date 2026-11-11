//! The pictures Settings › Appearance › Background offers beside the built-in
//! ones (`/api/backgrounds`): every picture added is kept as a file in
//! `backgrounds/` next to store.json, so every window and both the CLI server
//! and the desktop app offer the same ones: the page's own storage would lose
//! them with the port each run takes, and a picture is too large for
//! ui-state.json. Each has an id that never names another picture; settings
//! hold the id of the one shown.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};
use tablepeek_types::ApiError;

use super::{authorized, bad_request, internal_error, not_found, unauthorized, AppState};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

const DIR: &str = "backgrounds";
/// Before 0.7.4 there was one picture, in this file next to store.json. It
/// joins the pictures under this id, which the page maps its old stamp to.
const LEGACY_FILE: &str = "background.image";
const LEGACY_ID: &str = "legacy";
/// The largest picture taken: a 4K photo as a JPEG or WebP, with room.
const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/backgrounds",
            get(list).post(add).layer(DefaultBodyLimit::max(MAX_BYTES)),
        )
        .route("/api/backgrounds/{id}", get(read).delete(remove))
}

/// The picture's type, told by its first bytes: the formats every page's
/// browser engine (WebKit in the desktop app too) draws.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// An id names a file in the folder and nothing else: lowercase letters and
/// digits only.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The pictures' folder, made if missing, with the one picture kept before
/// 0.7.4 moved into it.
fn library(store_dir: &Path) -> Result<PathBuf, String> {
    let dir = store_dir.join(DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("배경 이미지 폴더를 만들 수 없습니다: {err}"))?;
    let legacy = store_dir.join(LEGACY_FILE);
    if legacy.exists() && !dir.join(LEGACY_ID).exists() {
        std::fs::rename(&legacy, dir.join(LEGACY_ID))
            .map_err(|err| format!("배경 이미지를 옮길 수 없습니다: {err}"))?;
    }
    Ok(dir)
}

/// The pictures' ids, the first added first.
fn ids(dir: &Path) -> Result<Vec<String>, String> {
    let mut found: Vec<(SystemTime, String)> = std::fs::read_dir(dir)
        .map_err(|err| format!("배경 이미지 폴더를 읽을 수 없습니다: {err}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            let meta = entry.metadata().ok()?;
            (valid_id(&id) && meta.is_file())
                .then(|| (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), id))
        })
        .collect();
    found.sort();
    Ok(found.into_iter().map(|(_, id)| id).collect())
}

async fn store_dir(state: &AppState) -> PathBuf {
    state.store.lock().await.dir().to_path_buf()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| internal_error(err.to_string()))?
        .map_err(internal_error)
}

/// GET: the pictures' ids, the first added first.
async fn list(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let dir = store_dir(&state).await;
    let pictures = blocking(move || ids(&library(&dir)?)).await?;
    Ok(Json(json!({ "pictures": pictures })))
}

/// POST: the body (PNG, JPEG, GIF or WebP) joins the pictures; answers its id.
async fn add(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if image_type(&body).is_none() {
        return Err(bad_request(
            "unsupported_image",
            "PNG, JPEG, GIF, WebP 이미지만 배경으로 쓸 수 있습니다",
        ));
    }
    let dir = store_dir(&state).await;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file = id.clone();
    blocking(move || {
        let dir = library(&dir)?;
        // Written beside, then moved into place: a page listing meanwhile
        // never meets half a picture.
        let temp = dir.join(format!("{file}.tmp"));
        std::fs::write(&temp, &body)
            .map_err(|err| format!("배경 이미지를 쓸 수 없습니다: {err}"))?;
        std::fs::rename(&temp, dir.join(&file))
            .map_err(|err| format!("배경 이미지를 저장할 수 없습니다: {err}"))
    })
    .await?;
    Ok(Json(json!({ "id": id })))
}

/// GET: one picture. Its bytes never change under its id, so the page may
/// keep them.
async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Response> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if !valid_id(&id) {
        return Err(not_found("배경 이미지가 없습니다"));
    }
    let dir = store_dir(&state).await;
    let found = blocking(move || {
        let path = library(&dir)?.join(&id);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("배경 이미지를 읽을 수 없습니다: {err}")),
        }
    })
    .await?;
    let Some(bytes) = found else {
        return Err(not_found("배경 이미지가 없습니다"));
    };
    let kind = image_type(&bytes).unwrap_or("application/octet-stream");
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(kind)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=31536000, immutable"),
            ),
        ],
        bytes,
    )
        .into_response())
}

/// DELETE: one picture goes; one already gone is no error.
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if !valid_id(&id) {
        return Err(not_found("배경 이미지가 없습니다"));
    }
    let dir = store_dir(&state).await;
    blocking(
        move || match std::fs::remove_file(library(&dir)?.join(&id)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("배경 이미지를 지울 수 없습니다: {err}")),
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::{ids, image_type, library, valid_id, LEGACY_FILE, LEGACY_ID};

    #[test]
    fn only_pictures_a_page_draws_are_taken() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a..."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(image_type(b"<svg xmlns="), None);
        assert_eq!(image_type(b""), None);
    }

    #[test]
    fn ids_name_nothing_outside_the_folder() {
        assert!(valid_id("3f2a9c"));
        assert!(valid_id(LEGACY_ID));
        assert!(!valid_id(""));
        assert!(!valid_id("../store.json"));
        assert!(!valid_id("a.tmp"));
        assert!(!valid_id("ABC"));
    }

    #[test]
    fn the_one_picture_kept_before_joins_the_library_once() {
        let store = std::env::temp_dir().join(format!(
            "tablepeek-backgrounds-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join(LEGACY_FILE), b"\x89PNG\r\n\x1a\nold").unwrap();
        let dir = library(&store).unwrap();
        assert!(!store.join(LEGACY_FILE).exists());
        assert_eq!(
            std::fs::read(dir.join(LEGACY_ID)).unwrap(),
            b"\x89PNG\r\n\x1a\nold"
        );
        // A half-written picture isn't listed.
        std::fs::write(dir.join("abc.tmp"), b"half").unwrap();
        assert_eq!(
            ids(&library(&store).unwrap()).unwrap(),
            vec![LEGACY_ID.to_string()]
        );
        std::fs::remove_dir_all(&store).unwrap();
    }
}
