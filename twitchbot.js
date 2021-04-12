const tmi = require('tmi.js');
const fs = require('fs');

const CHAT_CHANNEL = 'Manabender'; //The channel to send chat messages to.

//No OAuth key for you! This block reads the username and password from a private .gitignore-d file, then uses those credentials to connect to Twitch.
var credentials = {};
var client;
fs.readFile('credentials.txt', (err, data) => { if (err) throw err; credentials = JSON.parse(data); ConnectToTwitch(); });


// Constants and variables
const BOT_CONTROLLER = 'Manabender'; //Some commands only work when the bot controller issues them.
var addedControllers = ['caboozled']; //Array of people allowed to run elevated commands.
const BASE_POINTS = 1000; //The base number of points for a correct guess.
const STREAK_BONUS = 100; //The number of bonus points scored on a correct guess for each previous consecutive correct guess.
const MAX_SCORE_REQUESTS = 6; //The maximum number of !score requests that can be posted in a single message. This was determined experimentally with a 25 character username, 5 character score, and 2 character streak.
const SCORE_REQUEST_BATCH_WAIT = 5000; //The amount of time (in milliseconds) to wait after a !score request to batch-post them.
const LEADERS_COOLDOWN_WAIT = 15000; //The amount of time (in milliseconds) for which the bot will ignore further !leaders commands. Used in order to keep things less spammy.
const INITIAL_TIMESTAMP = Date.now(); //A UNIX timestamp. This is appended to scores and guesses files in order to keep them unique across multiple sessions.
var listeningForGuesses = false; //Are we listening for guesses?
var guesses = {}; //Object of guesses. Indices are named with the guesser's username. Values are their guesses.
var scores = {}; //Object of scores. Indices are named with the player's username. Scores are in scores.score. Current streak is in scores.streak.
var leaderNames = ['nobody1', 'nobody2', 'nobody3', 'nobody4', 'nobody5']; //Array of leaders. Indices are their position (index 0 is 1st place, etc.). Values are their names.
var leaderScores = [0, 0, 0, 0, 0]; //Array of leaders' scores. Indices are their position (index 0 is 1st place, etc.). Values are their scores.
var scoreRequests = []; //Array of people that have requested their !score.
var scoreTimeoutFunc; //Reference to timeout function used to batch-post !score requests.
var leadersTimeoutFunc; //Reference to timeout function used to handle !leaders cooldown.
var leadersAvailable = true; //Is the "cooldown" on the !leaders command available? If this is false, the bot will ignore !leaders requests.
var lineNumber = 0; //Line number to prepend every log.txt message with. This is useful for exporting the log to, say, Excel; with line numbers, we can tell when everything happened relative to everything else.
var roundNumber = 0; //Each question is one round. This is appended to scores and guesses files for record-keeping.
var postFinal = false; //Out of !open, !close, and !final, was !final the most recent? If not, !undofinal cannot be used.

//On start
fs.appendFile('log.txt', String(lineNumber).concat('\tBOT STARTED\n'), (err) =>
{
	if (err) throw err;
	console.log('Bot started');
});
lineNumber++;
//Read scores from file. NOTE: This file might need to exist beforehand. And it might need to contain a valid JSON. Note that {} is a valid JSON.
fs.readFile('scores.txt', (err, data) =>
{
	if (err) throw err;
	scores = JSON.parse(data);
	updateLeaders();
	fs.writeFile('scores-'.concat(INITIAL_TIMESTAMP).concat('-0.txt'), JSON.stringify(scores), (err) =>
	{
		if (err) throw err;
		console.log('> Score file 0 written');
	});
});

// Called every time a message comes in
function onMessageHandler(target, context, msg, self)
{
	if (self) { return; } // Ignore messages from the bot

	// Remove whitespace from chat message
	const commandName = msg.trim();

	if (commandName.substring(0, 6) === '!guess')
	{
		var guesser = context['username'];
		var ans = commandName.substring(7, 8);
		if (listeningForGuesses)
		{

			guesses[guesser] = ans;
			fs.appendFile('log.txt', String(lineNumber).concat('\t').concat(guesser).concat('\t').concat(ans).concat('\n'), (err) =>
			{
				if (err) throw err;
				console.log('> '.concat(guesser).concat(' guessed ').concat(ans));
			});
			lineNumber++;
		}
		else
		{
			console.log('> '.concat(guesser).concat(' tried to guess ').concat(ans).concat(' but guessing isn\'t open right now'));
		}

	}

	else if (commandName.substring(0, 6) === '!score')
	{
		/*
		const player = context['username'];
		var score = 0;
		var streak = 0;
		if (scores[player] == null) //Player not in score table.
		{
			console.log('> '.concat(player).concat(" asked for their score but they don't exist in the scoretable"));
			//score = 0;
			//streak = 0;
		}
		else //Player IS in scoretable
		{
			score = scores[player]["score"];
			streak = scores[player]["streak"];
			console.log('> '.concat(player).concat(" asked for their score, it is ").concat(score).concat( " and their streak is ").concat(streak));
		}
		client.action(CHAT_CHANNEL, "@".concat(player).concat(" Your score is ").concat(score).concat(" and your current streak is ").concat(streak));
		*/
		const player = context['username'];
		console.log('> Score command used by '.concat(player));
		scoreRequests.push(player);
		if (scoreRequests.length == 1) //First request in a batch, so start the timer for batch posting.
		{
			scoreTimeoutFunc = setTimeout(batchPostScores, SCORE_REQUEST_BATCH_WAIT);
		}
		else if (scoreRequests.length >= MAX_SCORE_REQUESTS) //Batch is full, so post immediately and cancel the timer.
		{
			clearTimeout(scoreTimeoutFunc);
			batchPostScores();
		}
	}

	else if (commandName.substring(0, 8) === '!leaders')
	{
		if (leadersAvailable)
		{
			console.log('> Leaders command used');
			var outString = '';
			for (var i = 1; i <= 5; i++)
			{
				outString = outString.concat(i).concat('. ');
				outString = outString.concat(leaderNames[i - 1]).concat(': ');
				outString = outString.concat(leaderScores[i - 1]).concat(' ||| ');
			}
			client.action(CHAT_CHANNEL, outString);
			leadersAvailable = false;
			leadersTimeoutFunc = setTimeout(function () { leadersAvailable = true; }, LEADERS_COOLDOWN_WAIT);
		}
		else
		{
			console.log('> Leaders command used but currently on cooldown');
		}
	}

	else if (commandName === '!open' && hasElevatedPermissions(context['username']))
	{
		roundNumber++;
		guesses = {};
		listeningForGuesses = true;
		postFinal = false;
		client.action(CHAT_CHANNEL, 'Guessing is open for round '.concat(roundNumber).concat('! Type !guess (number) to submit your answer choice.'));
		fs.appendFile('log.txt', String(lineNumber).concat('\tROUND ').concat(roundNumber).concat(' START-- GUESSING OPEN\n'), (err) =>
		{
			if (err) throw err;
			console.log('> Guessing opened');
		});
		lineNumber++;
	}

	else if (commandName === '!close' && hasElevatedPermissions(context['username']))
	{
		listeningForGuesses = false;
		postFinal = false;
		client.action(CHAT_CHANNEL, 'Guessing is closed for round '.concat(roundNumber).concat('.'));
		fs.writeFile('guesses.txt', JSON.stringify(guesses), (err) => //Write main guess file
		{
			if (err) throw err;
			console.log('> Guess file written');
		});
		fs.writeFile('guesses-'.concat(INITIAL_TIMESTAMP).concat('-').concat(roundNumber).concat('.txt'), JSON.stringify(guesses), (err) => //Also write secondary record-keeping guess file
		{
			if (err) throw err;
			console.log('> Guess file written');
		});
		fs.appendFile('log.txt', String(lineNumber).concat('\tGUESSING CLOSED FOR ROUND ').concat(roundNumber).concat(' -- IGNORE GUESSES PAST THIS POINT\n'), (err) =>
		{
			if (err) throw err;
			console.log('> Guessing closed');
		});
		lineNumber++;
	}

	else if (commandName === '!cancelopen' && hasElevatedPermissions(context['username']))
	{
		if (listeningForGuesses)
		{
			listeningForGuesses = false;
			client.action(CHAT_CHANNEL, 'Guessing has been cancelled for round '.concat(roundNumber).concat('.'));
			roundNumber--;
			fs.appendFile('log.txt', String(lineNumber).concat('\tGUESSING CANCELLED -- IGNORE GUESSES ABOVE\n'), (err) =>
			{
				if (err) throw err;
				console.log('> Guessing cancelled');
			});
			lineNumber++;
		}
		else
		{
			client.action(CHAT_CHANNEL, 'The !cancelopen command can only be used while guessing is open.');
		}
	}

	else if (commandName.substring(0, 6) === '!final' && hasElevatedPermissions(context['username']))
	{
		postFinal = true;
		var ans = commandName.substring(7, 8);
		client.action(CHAT_CHANNEL, 'Final answer is '.concat(ans).concat(' for round number ').concat(roundNumber).concat('.'));
		fs.appendFile('log.txt', String(lineNumber).concat('\tGUESS DECIDED FOR ROUND ').concat(roundNumber).concat(': CORRECT ANSWER WAS ').concat(ans).concat('\n'), (err) =>
		{
			if (err) throw err;
			console.log('> Final answer logged as '.concat(ans));
		});
		lineNumber++;
		//Process scores
		for (const [player, guess] of Object.entries(guesses))
		{
			//If the player isn't in the score table, add them.
			if (scores[player] == null)
			{
				scores[player] = {};
				scores[player]['score'] = 0;
				scores[player]['streak'] = 0;
			}
			//Did the player get it right?
			if (guess == ans || ans == '*')
			{
				scores[player]['score'] += BASE_POINTS;
				const bonus = STREAK_BONUS * scores[player]['streak'];
				scores[player]['score'] += bonus;
				scores[player]['streak']++;
			}
			else
			{
				scores[player]['streak'] = 0;
			}
		}
		//Write scores to file.
		fs.writeFile('scores.txt', JSON.stringify(scores), (err) => //Write main score file
		{
			if (err) throw err;
			console.log('> Score file written');
		});
		fs.writeFile('scores-'.concat(INITIAL_TIMESTAMP).concat('-').concat(roundNumber).concat('.txt'), JSON.stringify(scores), (err) => //Also write secondary record-keeping score file
		{
			if (err) throw err;
			console.log('> Score file written');
		});
		//Determine leaders.
		updateLeaders();
	}

	else if (commandName === '!undofinal' && hasElevatedPermissions(context['username']))
	{
		if (!postFinal)
		{
			client.action(CHAT_CHANNEL, 'The !undofinal command is only usable at the end of a round following a !final, before the next !open.')
			return;
		}
		postFinal = false;
		fs.readFile('scores-'.concat(INITIAL_TIMESTAMP).concat('-').concat(roundNumber - 1).concat('.txt'), (err, data) =>
		{
			if (err) throw err;
			scores = JSON.parse(data);
			updateLeaders();
			fs.appendFile('log.txt', String(lineNumber).concat('\tINCORRECT ANSWER LOGGED FOR ROUND ').concat(roundNumber).concat(': IGNORE PREVIOUS ANSWER AND USE NEXT INSTEAD\n'), (err) =>
			{
				if (err) throw err;
				console.log('> Undofinal command used.');
			});
			lineNumber++;
			client.action(CHAT_CHANNEL, 'Previous !final command undone; now please use !final with the correct answer.')
		});

	}

	else if (commandName === '!ping' && hasElevatedPermissions(context['username']))
	{
		client.action(CHAT_CHANNEL, 'Pong!');
		console.log('> Pong!');
	}

	else if (commandName === '!testcontroller' && hasElevatedPermissions(context['username']))
	{
		client.action(CHAT_CHANNEL, context['username'].concat(', you are a successfully-registered bot controller.'));
	}

	else if (commandName.substring(0, 14) === '!addcontroller' && context['display-name'] === BOT_CONTROLLER)
	{
		var newController = commandName.substring(15);
		addedControllers.push(newController);
		console.log('> Added new controller: '.concat(newController));
		client.action(CHAT_CHANNEL, 'Added new controller: '.concat(newController));
	}

	else if (commandName.substring(0, 17) === '!removecontroller' && context['display-name'] === BOT_CONTROLLER)
	{
		var newController = commandName.substring(18);
		var index = addedControllers.indexOf(newController);
		if (index > -1)
		{
			addedControllers.splice(index, 1);
			console.log('> Removed controller: '.concat(newController));
			client.action(CHAT_CHANNEL, 'Removed controller: '.concat(newController));
		}
		else
		{
			client.action(CHAT_CHANNEL, 'Couldn\'t find that user in the list of added controllers.');
		}
	}

	else if (commandName === '!recoverguesses' && context['display-name'] === BOT_CONTROLLER)
	{
		console.log('> Used command recoverguesses');
		listeningForGuesses = true;
		guesses = {};
		client.action(CHAT_CHANNEL, 'The bot has recovered from a crash or reboot in the middle of guessing. Unfortunately, this round\'s guesses could not be saved. IF YOU MADE A GUESS THIS ROUND, PLEASE SUBMIT IT AGAIN WITH !guess (number)');
		fs.appendFile('log.txt', String(lineNumber).concat('\tRECOVERED BOT MID-GUESSING -- GUESSING OPEN -- USE GUESSES BOTH ABOVE AND BELOW THIS LINE\n'), (err) =>
		{
			if (err) throw err;
		});
		lineNumber++;
	}

	else if (commandName === '!recoverround' && context['display-name'] === BOT_CONTROLLER)
	{
		console.log('> Used command recoverround');
		fs.readFile('guesses.txt', (err, data) => { if (err) throw err; guesses = JSON.parse(data); });
		client.action(CHAT_CHANNEL, 'The bot has recovered from a crash or reboot in the middle of a match. Guesses were saved, however. This message is mostly to inform Mana that the guess recovery process succeeded.');
		fs.appendFile('log.txt', String(lineNumber).concat('\tRECOVERED BOT AFTER GUESSING BUT BEFORE FINAL\n'), (err) =>
		{
			if (err) throw err;
		});
		lineNumber++;
	}

	else if (commandName === '!calcleaders' && context['display-name'] === BOT_CONTROLLER)
	{
		console.log('> Used command calcleaders');
		client.action(CHAT_CHANNEL, 'Rebuilding leader list.');
		updateLeaders();
	}

	else if (commandName === '!debug' && context['display-name'] === BOT_CONTROLLER)
	{
		console.log(guesses);
		console.log(leaderNames);
		console.log(leaderScores);
	}
}

// Called every time the bot connects to Twitch chat
function onConnectedHandler(addr, port)
{
	console.log('* Connected successfully to Twitch channel: '.concat(CHAT_CHANNEL));
}

function updateLeaders()
{
	leaderNames = ['nobody1', 'nobody2', 'nobody3', 'nobody4', 'nobody5'];
	leaderScores = [0, 0, 0, 0, 0];
	for (const [player, scoreObj] of Object.entries(scores))
	{
		const score = scoreObj['score'];
		for (var i = 0; i < 5; i++)
		{
			if (score > leaderScores[i])
			{
				//Shift everyone else down 1
				for (var j = 4; j > i; j--)
				{
					leaderNames[j] = leaderNames[j - 1];
					leaderScores[j] = leaderScores[j - 1];
				}
				leaderNames[i] = player;
				leaderScores[i] = score;
				break;
			}
		}
	}
}

function batchPostScores()
{
	console.log('> Batch-posting score requests');
	var outString = "";
	for (const player of scoreRequests)
	{
		var score = 0;
		var streak = 0;
		if (scores[player] == null) //Player not in score table.
		{
			//console.log('> '.concat(player).concat(" asked for their score but they don't exist in the scoretable"));
			//score = 0;
			//streak = 0;
		}
		else //Player IS in scoretable
		{
			score = scores[player]['score'];
			streak = scores[player]['streak'];
			//console.log('> '.concat(player).concat(" asked for their score, it is ").concat(score).concat(" and their streak is ").concat(streak));
		}
		outString = outString.concat('@').concat(player);
		outString = outString.concat(' Your score is ').concat(score);
		outString = outString.concat(' and your current streak is ').concat(streak).concat(' ||| ');
	}
	client.action(CHAT_CHANNEL, outString);
	scoreRequests = [];
}

function hasElevatedPermissions(user)
{
	if (user == BOT_CONTROLLER.toLowerCase())
	{
		return true;
	}
	if (addedControllers.includes(user))
	{
		return true;
	}
	return false;
}

function ConnectToTwitch()
{
	// Define configuration options
	const opts = {
		identity: {
			username: credentials['username'],
			password: credentials['password']
		},
		channels: [
			CHAT_CHANNEL
		]
	};

	// Create a client with our options
	client = new tmi.client(opts);

	// Register our event handlers (defined below)
	client.on('message', onMessageHandler);
	client.on('connected', onConnectedHandler);

	// Connect to Twitch:
	client.connect();
}