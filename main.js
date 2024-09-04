const axios = require("axios");
const inquirer = require("inquirer");
const MovieDB = require("node-themoviedb");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { dir } = require("console");

const tmdb = new MovieDB("89be02cb38d7d2d1f4322fd40d1504fa");

const prompt = inquirer.createPromptModule();

const projectDir = path.dirname(require.main.filename);

async function downloadSubtitle(subtitleUrl) {
  const tempDir = path.join(projectDir, "vlc-subtitles");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  filename = subtitleUrl.split("/").pop();
  const tempFilePath = path.join(tempDir, filename);
  
  const writer = fs.createWriteStream(tempFilePath);

  const response = await axios({
    url: subtitleUrl,
    method: "GET",
    responseType: "stream",
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve(tempFilePath));
    writer.on("error", reject);
  });
}

async function openInVLC(videoUrl, subtitleUrl = null) {
  let subtitlePath = null;

  if (subtitleUrl) {
    try {
      subtitlePath = await downloadSubtitle(subtitleUrl);
    } catch (error) {
      console.error("Failed to download subtitle:", error);
      return;
    }
  }

  let command = `vlc "${videoUrl}"`;

  if (subtitlePath) {
    command += ` --sub-file="${subtitlePath}"`;
  }

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error opening VLC: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`VLC stderr: ${stderr}`);
      return;
    }
    console.log(`VLC output: ${stdout}`);
  });
}

async function searchTitle() {
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

  const { selectedMovie } = await prompt([
    {
      type: "list",
      name: "selectedMovie",
      message: "Select a title:",
      choices,
    },
  ]);

  return searchResults.data.results.find((movie) => movie.id === selectedMovie);
}

async function getIMDBId(id, media_type) {
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
}

async function getStreams(imdbId, season = null, episode = null) {
  let apiUrl = `http://localhost:8657/${imdbId}`;
  if (season && episode) {
    apiUrl += `/${season}/${episode}`;
  }

  const response = await axios.get(apiUrl);
  return response.data;
}

async function selectStreamAndCaption(streams, captions) {
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
      choices: captions.map((caption) => ({
        name: `${caption.language} (${caption.type})`,
        value: caption.url,
      })),
    },
  ]);

  console.log(`Selected stream: ${selectedStream}`);
  console.log(`Selected caption: ${selectedCaption}`);

  await openInVLC(selectedStream, selectedCaption);
}

async function main() {
  const selectedMovie = await searchTitle();
  const imdbId = await getIMDBId(selectedMovie.id, selectedMovie.media_type);

  let streams, captions;

  if (selectedMovie.media_type === "tv") {
    const seasons = Array.from({ length: 10 }, (_, i) => i + 1).map((num) => ({
      name: `Season ${num}`,
      value: num,
    }));

    const { season } = await prompt([
      {
        type: "list",
        name: "season",
        message: "Select season number (or type to select):",
        choices: seasons,
        filter: (input) => parseInt(input),
      },
    ]);

    const episodes = Array.from({ length: 20 }, (_, i) => i + 1).map((num) => ({
      name: `Episode ${num}`,
      value: num,
    }));

    const { episode } = await prompt([
      {
        type: "list",
        name: "episode",
        message: "Select episode number (or type to select):",
        choices: episodes,
        filter: (input) => parseInt(input),
      },
    ]);

    const response = await getStreams(imdbId, season, episode);
    streams = response.stream.qualities;
    captions = response.stream.captions;
  } else {
    const response = await getStreams(imdbId);
    streams = response.stream.qualities;
    captions = response.stream.captions;
  }

  await selectStreamAndCaption(streams, captions);
}

main();
