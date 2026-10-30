use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::transcript::{TranscriptSegment, TranslationState};

pub const SCHEMA_VERSION: u32 = 1;

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibrarySourceKind {
    Live,
    Media,
    Subtitle,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySource {
    pub kind: LibrarySourceKind,
    pub label: String,
    pub url: Option<String>,
    pub id: Option<String>,
    pub media_path: Option<String>,
    pub pcm_path: Option<String>,
    #[typeshare(serialized_as = "Option<u32>")]
    pub duration_ms: Option<u64>,
    pub derived_from_id: Option<String>,
    #[serde(default)]
    pub source_lang: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VersionOrigin {
    Asr,
    Live,
    User,
    Machine,
    Restore,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentVersion {
    pub revision: u32,
    pub source_revision: u32,
    pub text: String,
    pub translation: Option<String>,
    pub translation_state: TranslationState,
    #[serde(default)]
    pub translation_error: Option<String>,
    #[typeshare(serialized_as = "number")]
    pub committed_at: u64,
    pub origin: VersionOrigin,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySegment {
    pub segment: TranscriptSegment,
    pub source_revision: u32,
    pub bookmarked: bool,
    pub note: String,
    pub bookmark_version: Option<u32>,
    pub versions: Vec<SegmentVersion>,
    #[serde(default)]
    pub source_edited: bool,
    #[serde(default)]
    pub translation_edited: bool,
    #[serde(default)]
    pub live_revision: u32,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRecord {
    pub schema_version: u32,
    pub revision: u32,
    pub id: String,
    pub title: String,
    #[typeshare(serialized_as = "number")]
    pub created_at: u64,
    #[typeshare(serialized_as = "number")]
    pub updated_at: u64,
    pub source: LibrarySource,
    pub segments: Vec<LibrarySegment>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub schema_version: u32,
    pub revision: u32,
    pub id: String,
    pub title: String,
    #[typeshare(serialized_as = "number")]
    pub created_at: u64,
    #[typeshare(serialized_as = "number")]
    pub updated_at: u64,
    pub source: LibrarySource,
    pub segment_count: u32,
    pub bookmark_count: u32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchHit {
    pub record_id: String,
    pub segment_id: String,
    #[typeshare(serialized_as = "number")]
    pub start_ms: u64,
    pub field: String,
    pub excerpt: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryReadIssue {
    pub id: String,
    pub error: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListing {
    pub records: Vec<LibrarySummary>,
    pub hits: Vec<LibrarySearchHit>,
    pub issues: Vec<LibraryReadIssue>,
}

impl From<LibraryRecord> for LibrarySummary {
    fn from(record: LibraryRecord) -> Self {
        Self {
            schema_version: record.schema_version,
            revision: record.revision,
            id: record.id,
            title: record.title,
            created_at: record.created_at,
            updated_at: record.updated_at,
            source: record.source,
            segment_count: record.segments.len() as u32,
            bookmark_count: record.segments.iter().filter(|s| s.bookmarked).count() as u32,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentPatch {
    pub expected_revision: u32,
    pub text: Option<String>,
    pub translation: Option<String>,
    pub note: Option<String>,
    pub bookmarked: Option<bool>,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    pub id: String,
    pub source: String,
    pub target: String,
    pub note: String,
    #[typeshare(serialized_as = "number")]
    pub created_at: u64,
    #[typeshare(serialized_as = "number")]
    pub updated_at: u64,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermSuggestion {
    pub segment_id: String,
    pub term_id: String,
    #[typeshare(serialized_as = "number")]
    pub term_updated_at: u64,
    pub expected_revision: u32,
    pub source: String,
    pub target: String,
    pub original_translation: String,
    pub suggested_translation: String,
    pub occurrences: u32,
    pub explanation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TermInput {
    pub id: Option<String>,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub note: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEvidence {
    pub segment_id: String,
    #[typeshare(serialized_as = "number")]
    pub start_ms: u64,
    #[typeshare(serialized_as = "number")]
    pub end_ms: u64,
    pub text: String,
    pub translation: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChapter {
    pub title: String,
    #[typeshare(serialized_as = "number")]
    pub start_ms: u64,
    #[typeshare(serialized_as = "number")]
    pub end_ms: u64,
    pub segment_ids: Vec<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPoint {
    pub text: String,
    #[typeshare(serialized_as = "number")]
    pub start_ms: u64,
    #[typeshare(serialized_as = "number")]
    pub end_ms: u64,
    pub segment_ids: Vec<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAnalysis {
    pub method: String,
    pub notice: String,
    pub chapters: Vec<LibraryChapter>,
    pub points: Vec<LibraryPoint>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAnswer {
    pub method: String,
    pub answer: String,
    pub evidence: Vec<LibraryEvidence>,
}
