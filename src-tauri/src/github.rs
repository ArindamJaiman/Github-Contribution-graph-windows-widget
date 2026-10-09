//! GitHub contribution fetching & parsing.
//!
//! Two strategies are supported:
//! - GraphQL API (requires a personal access token, exact counts & levels)
//! - Scraping the public contributions fragment (no token needed)

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::{Datelike, NaiveDate};
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ContributionDay {
    pub date: String,
    pub count: i32,
    pub level: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CachedData {
    pub weeks: Vec<Vec<ContributionDay>>,
    #[serde(rename = "lastFetched")]
    pub last_fetched: Option<String>,
    pub username: Option<String>,
}

/// Aggregated numbers used by the tray tooltip and notifications.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Summary {
    pub total: i64,
    pub current_streak: u32,
    pub today_count: i32,
}

// ── Validation ──────────────────────────────────────────────────────────────

/// GitHub logins are 1-39 chars of letters, digits and hyphens. Underscores are
/// accepted for Enterprise Managed Users. Validating here also keeps usernames
/// safe to use in file names, URLs and window labels.
pub fn is_valid_username(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 39
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn validate_username(name: &str) -> Result<String, String> {
    let trimmed = name.trim().trim_start_matches('@');
    if is_valid_username(trimmed) {
        Ok(trimmed.to_string())
    } else {
        Err(format!("\"{}\" is not a valid GitHub username", name.trim()))
    }
}

// ── Levels ──────────────────────────────────────────────────────────────────

pub fn count_to_level(count: i32) -> i32 {
    match count {
        i32::MIN..=0 => 0,
        1..=3 => 1,
        4..=6 => 2,
        7..=9 => 3,
        _ => 4,
    }
}

fn level_to_approx_count(level: i32) -> i32 {
    match level {
        1 => 1,
        2 => 4,
        3 => 7,
        4 => 10,
        _ => 0,
    }
}

fn graphql_level(level: &str, count: i32) -> i32 {
    match level {
        "NONE" => 0,
        "FIRST_QUARTILE" => 1,
        "SECOND_QUARTILE" => 2,
        "THIRD_QUARTILE" => 3,
        "FOURTH_QUARTILE" => 4,
        _ => count_to_level(count),
    }
}

// ── Grouping & summaries ────────────────────────────────────────────────────

/// Groups chronologically sorted days into Sunday-first weeks.
pub fn group_days_into_weeks(days: Vec<ContributionDay>) -> Vec<Vec<ContributionDay>> {
    let mut weeks = Vec::new();
    let mut current_week: Vec<ContributionDay> = Vec::with_capacity(7);

    for day in days {
        let is_sunday = NaiveDate::parse_from_str(&day.date, "%Y-%m-%d")
            .map(|d| d.weekday() == chrono::Weekday::Sun)
            .unwrap_or(false);

        if is_sunday && !current_week.is_empty() {
            weeks.push(std::mem::replace(&mut current_week, Vec::with_capacity(7)));
        }
        current_week.push(day);
    }

    if !current_week.is_empty() {
        weeks.push(current_week);
    }
    weeks
}

/// Computes total, current streak and today's count. The last calendar day is
/// GitHub's "today": a zero there doesn't break the streak (the day isn't over).
/// `today` is the local date used to look up today's count for reminders.
pub fn summarize(weeks: &[Vec<ContributionDay>], today: NaiveDate) -> Summary {
    let today_str = today.format("%Y-%m-%d").to_string();
    let days: Vec<&ContributionDay> = weeks.iter().flatten().collect();

    let total = days.iter().map(|d| d.count.max(0) as i64).sum();
    let today_count = days
        .iter()
        .rev()
        .find(|d| d.date == today_str)
        .map(|d| d.count)
        .unwrap_or(0);

    let mut current_streak = 0u32;
    for (i, day) in days.iter().rev().enumerate() {
        if day.count > 0 {
            current_streak += 1;
        } else if i > 0 {
            break;
        }
    }

    Summary { total, current_streak, today_count }
}

// ── HTML scraping ───────────────────────────────────────────────────────────

fn td_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"<td\b[^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*>"#).unwrap())
}

fn attr_regex(name: &'static str) -> Regex {
    Regex::new(&format!(r#"\b{}="([^"]*)""#, name)).unwrap()
}

fn id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| attr_regex("id"))
}

fn level_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| attr_regex("data-level"))
}

fn tooltip_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>\s*([^<]*?)\s*</tool-tip>"#).unwrap()
    })
}

fn count_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([\d,]+)\s+contribution").unwrap())
}

fn tooltip_count(text: &str) -> Option<i32> {
    if text.starts_with("No contribution") {
        return Some(0);
    }
    count_regex()
        .captures(text)
        .and_then(|c| c[1].replace(',', "").parse::<i32>().ok())
}

/// Parses GitHub's contribution calendar markup. Cells and tooltips are joined
/// by id (`<td id=X>` ↔ `<tool-tip for=X>`), so "No contributions" tooltips and
/// attribute ordering can't misalign counts.
pub fn parse_contributions_html(html: &str) -> Vec<ContributionDay> {
    let counts: HashMap<&str, i32> = tooltip_regex()
        .captures_iter(html)
        .filter_map(|cap| {
            let id = cap.get(1)?.as_str();
            let count = tooltip_count(cap.get(2)?.as_str())?;
            Some((id, count))
        })
        .collect();

    let mut days: Vec<ContributionDay> = td_regex()
        .captures_iter(html)
        .map(|cap| {
            let tag = cap.get(0).unwrap().as_str();
            let date = cap[1].to_string();
            let level = level_regex()
                .captures(tag)
                .and_then(|c| c[1].parse::<i32>().ok())
                .unwrap_or(0)
                .clamp(0, 4);
            let count = id_regex()
                .captures(tag)
                .and_then(|c| counts.get(c.get(1).unwrap().as_str()).copied())
                .unwrap_or_else(|| level_to_approx_count(level));
            ContributionDay { date, count, level }
        })
        .collect();

    days.sort_by(|a, b| a.date.cmp(&b.date));
    days.dedup_by(|a, b| a.date == b.date);
    days
}

// ── Network ─────────────────────────────────────────────────────────────────

pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("GitHubContributionWidget/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .connect_timeout(std::time::Duration::from_secs(8))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .expect("failed to build HTTP client")
}

const GRAPHQL_QUERY: &str = r#"
query ($username: String!) {
  user(login: $username) {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            contributionCount
            contributionLevel
            date
          }
        }
      }
    }
  }
}
"#;

async fn fetch_via_graphql(
    client: &reqwest::Client,
    username: &str,
    token: &str,
) -> Result<Vec<Vec<ContributionDay>>, String> {
    let body = serde_json::json!({ "query": GRAPHQL_QUERY, "variables": { "username": username } });

    let response = client
        .post("https://api.github.com/graphql")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    match response.status().as_u16() {
        200..=299 => {}
        401 => return Err("token rejected (401) — check or regenerate it".into()),
        403 => return Err("API rate limit or permission error (403)".into()),
        s => return Err(format!("GitHub API returned HTTP {}", s)),
    }

    let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if let Some(msg) = data
        .pointer("/errors/0/message")
        .and_then(|m| m.as_str())
    {
        return Err(msg.to_string());
    }

    let weeks_val = data
        .pointer("/data/user/contributionsCollection/contributionCalendar/weeks")
        .and_then(|w| w.as_array())
        .ok_or_else(|| format!("GitHub user \"{}\" not found", username))?;

    let weeks = weeks_val
        .iter()
        .map(|week| {
            week.get("contributionDays")
                .and_then(|d| d.as_array())
                .map(|days| {
                    days.iter()
                        .map(|day| {
                            let count = day
                                .get("contributionCount")
                                .and_then(|c| c.as_i64())
                                .unwrap_or(0) as i32;
                            let level = graphql_level(
                                day.get("contributionLevel").and_then(|l| l.as_str()).unwrap_or(""),
                                count,
                            );
                            let date = day.get("date").and_then(|d| d.as_str()).unwrap_or_default().to_string();
                            ContributionDay { date, count, level }
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .filter(|w: &Vec<ContributionDay>| !w.is_empty())
        .collect::<Vec<_>>();

    if weeks.is_empty() {
        return Err("GitHub API returned an empty calendar".into());
    }
    Ok(weeks)
}

async fn fetch_via_scraping(
    client: &reqwest::Client,
    username: &str,
) -> Result<Vec<Vec<ContributionDay>>, String> {
    let url = format!("https://github.com/users/{}/contributions", username);
    let response = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "text/html")
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    match response.status().as_u16() {
        200..=299 => {}
        404 => return Err(format!("GitHub user \"{}\" not found", username)),
        429 => return Err("GitHub is rate limiting requests — add a token or try later".into()),
        s => return Err(format!("GitHub returned HTTP {}", s)),
    }

    let html = response.text().await.map_err(|e| e.to_string())?;
    let weeks = group_days_into_weeks(parse_contributions_html(&html));

    if weeks.is_empty() {
        return Err(format!(
            "Could not read contributions for \"{}\". Add a personal access token for reliable data.",
            username
        ));
    }
    Ok(weeks)
}

/// Fetches the last year of contributions, preferring the GraphQL API when a
/// token is available and falling back to scraping.
pub async fn fetch_contributions(
    client: &reqwest::Client,
    username: &str,
    token: &str,
) -> Result<Vec<Vec<ContributionDay>>, String> {
    if token.is_empty() {
        return fetch_via_scraping(client, username).await;
    }
    match fetch_via_graphql(client, username, token).await {
        Ok(weeks) => Ok(weeks),
        Err(api_err) => fetch_via_scraping(client, username)
            .await
            .map_err(|scrape_err| format!("{} (API: {})", scrape_err, api_err)),
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, count: i32) -> ContributionDay {
        ContributionDay { date: date.into(), count, level: count_to_level(count) }
    }

    const SAMPLE: &str = r#"
      <table><tbody>
        <tr>
          <td tabindex="0" data-ix="0" style="width: 10px" data-date="2024-10-06" id="contribution-day-component-0-0" data-level="0" role="gridcell" class="ContributionCalendar-day"></td>
          <td tabindex="0" data-ix="1" data-date="2024-10-13" id="contribution-day-component-0-1" data-level="2" role="gridcell" class="ContributionCalendar-day"></td>
        </tr>
        <tr>
          <td data-level="4" id="contribution-day-component-1-0" data-date="2024-10-07" class="ContributionCalendar-day"></td>
          <td data-date="2024-10-14" id="contribution-day-component-1-1" data-level="1" class="ContributionCalendar-day"></td>
        </tr>
      </tbody></table>
      <tool-tip id="tooltip-a" for="contribution-day-component-0-0" popover="manual" class="sr-only">No contributions on October 6th.</tool-tip>
      <tool-tip id="tooltip-b" for="contribution-day-component-0-1" popover="manual" class="sr-only">5 contributions on October 13th.</tool-tip>
      <tool-tip id="tooltip-c" for="contribution-day-component-1-0" popover="manual" class="sr-only">1,204 contributions on October 7th.</tool-tip>
    "#;

    #[test]
    fn parses_cells_and_joins_tooltips_by_id() {
        let days = parse_contributions_html(SAMPLE);
        assert_eq!(
            days,
            vec![
                ContributionDay { date: "2024-10-06".into(), count: 0, level: 0 },
                ContributionDay { date: "2024-10-07".into(), count: 1204, level: 4 },
                ContributionDay { date: "2024-10-13".into(), count: 5, level: 2 },
                // no tooltip → approximated from level
                ContributionDay { date: "2024-10-14".into(), count: 1, level: 1 },
            ]
        );
    }

    #[test]
    fn groups_into_sunday_weeks() {
        let days = vec![
            day("2024-10-03", 1), // Thu
            day("2024-10-04", 0),
            day("2024-10-05", 2), // Sat
            day("2024-10-06", 3), // Sun
            day("2024-10-07", 0),
        ];
        let weeks = group_days_into_weeks(days);
        assert_eq!(weeks.len(), 2);
        assert_eq!(weeks[0].len(), 3);
        assert_eq!(weeks[1][0].date, "2024-10-06");
    }

    #[test]
    fn streak_ignores_empty_today_but_not_empty_yesterday() {
        let today = NaiveDate::from_ymd_opt(2024, 10, 10).unwrap();
        let weeks = vec![vec![
            day("2024-10-06", 0),
            day("2024-10-07", 2),
            day("2024-10-08", 1),
            day("2024-10-09", 4),
            day("2024-10-10", 0),
        ]];
        let s = summarize(&weeks, today);
        assert_eq!(s.current_streak, 3);
        assert_eq!(s.today_count, 0);
        assert_eq!(s.total, 7);

        let weeks = vec![vec![day("2024-10-08", 1), day("2024-10-09", 0), day("2024-10-10", 0)]];
        assert_eq!(summarize(&weeks, today).current_streak, 0);
    }

    #[test]
    fn today_count_uses_local_date() {
        // GitHub's calendar can run a day ahead of local time (UTC).
        let today = NaiveDate::from_ymd_opt(2024, 10, 10).unwrap();
        let weeks = vec![vec![day("2024-10-10", 2), day("2024-10-11", 9)]];
        let s = summarize(&weeks, today);
        assert_eq!(s.total, 11);
        assert_eq!(s.today_count, 2);
        assert_eq!(s.current_streak, 2);
    }

    #[test]
    fn username_validation() {
        assert!(is_valid_username("octocat"));
        assert!(is_valid_username("some-user-42"));
        assert!(!is_valid_username(""));
        assert!(!is_valid_username("-leading"));
        assert!(!is_valid_username("../etc"));
        assert!(!is_valid_username("has space"));
        assert!(!is_valid_username(&"a".repeat(40)));
        assert_eq!(validate_username("  @octocat ").unwrap(), "octocat");
    }

    #[test]
    fn levels() {
        assert_eq!(count_to_level(0), 0);
        assert_eq!(count_to_level(3), 1);
        assert_eq!(count_to_level(10), 4);
        assert_eq!(graphql_level("THIRD_QUARTILE", 0), 3);
        assert_eq!(graphql_level("???", 5), 2);
    }
}
