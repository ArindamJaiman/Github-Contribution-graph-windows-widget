const axios = require('axios');

/**
 * Fetch GitHub contribution data using the GraphQL API.
 * Falls back to profile page scraping if no token is provided or GraphQL fails.
 *
 * @param {string} username - GitHub username
 * @param {string} token    - Personal access token (optional)
 * @returns {Array<Array<{date: string, count: number, level: number}>>} weeks array
 */
async function fetchContributions(username, token) {
  if (token) {
    try {
      return await fetchViaGraphQL(username, token);
    } catch (err) {
      console.warn('GraphQL fetch failed, falling back to scraping:', err.message);
    }
  }
  return await fetchViaScraping(username);
}

/**
 * Option A: GitHub GraphQL API (requires token with read:user scope)
 */
async function fetchViaGraphQL(username, token) {
  const query = `
    query ($username: String!) {
      user(login: $username) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
                color
              }
            }
          }
        }
      }
    }
  `;

  const response = await axios.post(
    'https://api.github.com/graphql',
    { query, variables: { username } },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  if (response.data.errors) {
    throw new Error(response.data.errors[0].message);
  }

  const calendar = response.data.data.user.contributionsCollection.contributionCalendar;
  const weeks = calendar.weeks.map(week =>
    week.contributionDays.map(day => ({
      date: day.date,
      count: day.contributionCount,
      level: countToLevel(day.contributionCount)
    }))
  );

  return weeks;
}

/**
 * Option B: Scrape the GitHub profile page contribution graph
 */
async function fetchViaScraping(username) {
  const url = `https://github.com/users/${username}/contributions`;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  const html = response.data;
  const days = [];
  // GitHub's contribution page uses <td> elements with data attributes
  const tdRegex = /<td[^>]*data-date="([^"]*)"[^>]*data-level="(\d)"[^>]*>/g;
  let match;

  // Also try to extract contribution counts from tooltips or spans
  const tooltipRegex = /<tool-tip[^>]*>(\d+)\s+contribution/g;
  const counts = [];
  let tooltipMatch;
  while ((tooltipMatch = tooltipRegex.exec(html)) !== null) {
    counts.push(parseInt(tooltipMatch[1], 10));
  }

  let index = 0;
  while ((match = tdRegex.exec(html)) !== null) {
    const date = match[1];
    const level = parseInt(match[2], 10);
    const count = counts[index] !== undefined ? counts[index] : levelToApproxCount(level);

    days.push({ date, count, level });
    index++;
  }

  // GitHub renders the graph row by row (all Sundays, then all Mondays, etc.)
  days.sort((a, b) => new Date(a.date) - new Date(b.date));

  const weeks = groupDaysIntoWeeks(days);

  // If regex parsing failed, try alternative approach
  if (weeks.length === 0) {
    return await fetchViaContribPage(username);
  }

  return weeks;
}

/**
 * Alternative scraping approach using GitHub's contribution calendar page
 */
async function fetchViaContribPage(username) {
  const url = `https://github.com/${username}`;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  const html = response.data;
  const days = [];
  // Look for data-date and data-level attributes in table cells
  const cellRegex = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)"/g;
  let match;

  while ((match = cellRegex.exec(html)) !== null) {
    const date = match[1];
    const level = parseInt(match[2], 10);
    days.push({ date, count: levelToApproxCount(level), level });
  }

  days.sort((a, b) => new Date(a.date) - new Date(b.date));

  const weeks = groupDaysIntoWeeks(days);

  if (weeks.length === 0) {
    throw new Error(`Could not fetch contributions for "${username}". Check the username or provide a personal access token.`);
  }

  return weeks;
}

/**
 * Convert contribution count to a 0–4 level (GitHub style)
 */
function countToLevel(count) {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 6) return 2;
  if (count <= 9) return 3;
  return 4;
}

/**
 * Approximate a contribution count from a level (for scraping fallback)
 */
function levelToApproxCount(level) {
  switch (level) {
    case 0: return 0;
    case 1: return 1;
    case 2: return 4;
    case 3: return 7;
    case 4: return 10;
    default: return 0;
  }
}

/**
 * Groups a flat array of day objects into an array of week arrays
 * starting on Sundays.
 */
function groupDaysIntoWeeks(days) {
  const weeks = [];
  let currentWeek = [];

  for (const day of days) {
    // Determine the day of the week (0 = Sunday)
    const dayOfWeek = new Date(day.date + 'T00:00:00').getDay();
    
    if (dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(day);
  }

  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }

  return weeks;
}

module.exports = { fetchContributions };
