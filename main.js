const axios = require("axios");
const inquirer = require("inquirer");
const MovieDB = require("node-themoviedb");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
var clc = require("cli-color");

const tmdb = new MovieDB("89be02cb38d7d2d1f4322fd40d1504fa");
const prompt = inquirer.createPromptModule();
const projectDir = path.dirname(require.main.filename);

async function printMediaInfo(media) {
  console.log();
  console.log(clc.bold("Media Info:"));
  console.log(clc.bold("Type:"), clc.red(media.type));
  console.log(clc.bold("Title:"), clc.green(media.title));
  console.log(clc.bold("Release Year:"), media.releaseYear);

  if (media.season) {
    console.log(clc.bold("Season:"), media.season.number);
  }
  if (media.episode) {
    console.log(clc.bold("Episode:"), media.episode.number);
    console.log(clc.bold("Episode Name:"), media.episode.name);
  }
  console.log();
}

async function downloadSubtitle(subtitleUrl) {
  const tempDir = path.join(projectDir, "vlc-subtitles");

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const filename = subtitleUrl.split("/").pop();
  const tempFilePath = path.join(tempDir, filename);

  if (fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 0) {
    return tempFilePath;
  }

  const writer = fs.createWriteStream(tempFilePath);

  try {
    const response = await axios({
      url: subtitleUrl,
      method: "GET",
      responseType: "stream",
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => resolve(tempFilePath));
      writer.on("error", (err) => {
        console.error(clc.red("Failed to write subtitle file:"), err.message);
        reject(err);
      });
    });
  } catch (error) {
    console.error(clc.red("Failed to download subtitle:"), error.message);
    throw error;
  }
}

async function openInVLC(videoUrl, subtitleUrl = null) {
  let subtitlePath = null;

  if (subtitleUrl) {
    try {
      subtitlePath = await downloadSubtitle(subtitleUrl);
    } catch (error) {
      console.error(clc.red("Failed to download subtitle:"), error.message);
      return;
    }
  }

  let command = `vlc "${videoUrl}"`;

  if (subtitlePath) {
    command += ` --sub-file="${subtitlePath}"`;
  }

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(clc.red(`Error opening VLC: ${error.message}`));
      return;
    }
    if (stderr) {
      console.error(clc.red(`VLC stderr: ${stderr}`));
      return;
    }
  });
}

async function getTvSeasonsAndEpisodes(tmdb_id) {
  try {
    const response = await tmdb.tv.getDetails({
      pathParameters: {
        tv_id: tmdb_id,
      },
    });

    const seasons = response.data.seasons
      .filter((season) => season.season_number !== 0)
      .map((season) => ({
        name: `Season ${season.season_number}`,
        value: season.season_number,
      }));

    if (seasons.length === 0) {
      console.error(clc.red("No seasons found for this TV show."));
      return;
    }

    const { season } = await prompt([
      {
        type: "list",
        name: "season",
        message: "Select season number (or type to select):",
        choices: seasons,
        filter: (input) => parseInt(input),
      },
    ]);

    const seasonDetails = await tmdb.tv.season.getDetails({
      pathParameters: {
        tv_id: tmdb_id,
        season_number: season,
      },
    });

    const episodes = seasonDetails.data.episodes.map((episode) => ({
      name: `Episode ${episode.episode_number} - ${episode.name}`,
      value: episode.episode_number,
    }));

    if (episodes.length === 0) {
      console.error(clc.red("No episodes found for this season."));
      return;
    }

    const { episode } = await prompt([
      {
        type: "list",
        name: "episode",
        message: "Select episode number (or type to select):",
        choices: episodes,
        filter: (input) => parseInt(input),
      },
    ]);

    return { season, episode };
  } catch (error) {
    console.error(clc.red("Failed to get TV seasons and episodes:"), error.message);
    throw error;
  }
}

async function searchTitle() {
  try {
    const { title } = await prompt([
      {
        type: "input",
        name: "title",
        message: "Enter the title to search:",
      },
    ]);

    const searchResults = await tmdb.search.multi({
      query: {
        query: title,
      },
    });

    const choices = searchResults.data.results
      .filter((result) => result.media_type !== "person") // Exclude persons (actors)
      .map((result) => ({
        name: `${result.title || result.name} (${
          result.release_date
            ? result.release_date.split("-")[0]
            : result.first_air_date
            ? result.first_air_date.split("-")[0]
            : "N/A"
        })`,
        value: result.id,
        media_type: result.media_type, // Include media type for later use
      }));

    if (choices.length === 0) {
      console.error(clc.red("No results found for the given title."));
      return;
    }

    const { selectedMovie } = await prompt([
      {
        type: "list",
        name: "selectedMovie",
        message: "Select a title:",
        choices,
      },
    ]);

    return searchResults.data.results.find((movie) => movie.id === selectedMovie);
  } catch (error) {
    console.error(clc.red("Failed to search for title:"), error.message);
    throw error;
  }
}

async function getIMDBId(id, media_type) {
  try {
    if (media_type === "tv") {
      const response = await tmdb.tv.getExternalIDs({
        pathParameters: {
          tv_id: id,
        },
      });
      return response.data.imdb_id;
    } else {
      const response = await tmdb.movie.getExternalIDs({
        pathParameters: {
          movie_id: id,
        },
      });
      return response.data.imdb_id;
    }
  } catch (error) {
    console.error(clc.red("Failed to get IMDb ID:"), error.message);
    throw error;
  }
}

async function getStreams(imdbId, season = null, episode = null) {
  let apiUrl = `http://localhost:8657/${imdbId}`;
  if (season && episode) {
    apiUrl += `/${season}/${episode}`;
  }

  try {
    const response = await axios.get(apiUrl);
    if (!response.data || !response.data.stream) {
      console.error(clc.red("No streams found for this content."));
      return { stream: { qualities: {}, captions: [] }, media: {} };
    }
    return response.data;
  } catch (error) {
    console.error(clc.red("Failed to get streams:"), error.message);
    throw error;
  }
}

async function selectStreamAndCaption(streams, captions) {
  try {
    if (!streams || Object.keys(streams).length === 0) {
      console.error(clc.red("No streams available."));
      return;
    }

    if (!captions || captions.length === 0) {
      console.error(clc.red("No captions available."));
    }

    const { selectedStream } = await prompt([
      {
        type: "list",
        name: "selectedStream",
        message: "Select a stream:",
        choices: Object.keys(streams).map((quality) => ({
          name: `${quality} (${streams[quality].type})`,
          value: streams[quality].url,
        })),
      },
    ]);

    const { selectedCaption } = await prompt([
      {
        type: "list",
        name: "selectedCaption",
        message: "Select a caption:",
        choices: captions
          .filter(
            (caption) => caption.language === "en" || caption.language === "ar"
          )
          .map((caption) => ({
            name: `${caption.language} (${caption.type}) ${
              caption.opensubtitles ? "opensubtitles" : ""
            }`,
            value: caption.url,
          })),
      },
    ]);

    await openInVLC(selectedStream, selectedCaption);
  } catch (error) {
    console.error(clc.red("Failed to select stream or caption:"), error.message);
  }
}

async function main() {
  try {
    const selectedMovie = await searchTitle();
    if (!selectedMovie) return;

    const imdbId = await getIMDBId(selectedMovie.id, selectedMovie.media_type);

    let streams, captions, media;

    if (selectedMovie.media_type === "tv") {
      const { season, episode } = await getTvSeasonsAndEpisodes(selectedMovie.id);
      if (!season || !episode) return;

      const response = await getStreams(imdbId, season, episode);
      streams = response.stream.qualities;
      captions = response.stream.captions;
      media = response.media;
    } else {
      const response = await getStreams(imdbId);
      streams = response.stream.qualities;
      captions = response.stream.captions;
      media = response.media;
    }

    await printMediaInfo(media);
    await selectStreamAndCaption(streams, captions);
  } catch (error) {
    console.error(clc.red("An error occurred:"), error.message);
  }
}

main();
