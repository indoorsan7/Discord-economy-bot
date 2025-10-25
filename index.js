require('dotenv').config();

const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    PermissionsBitField,
    EmbedBuilder,
    ChannelType
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

// --- 経済システム (インメモリデータストア) ---
const userBalance = new Map();
const userCooldowns = new Map();

// クールタイム定義 (ミリ秒)
const COOLDOWN_WORK_MS = 60 * 60 * 1000;      // 1時間
const COOLDOWN_ROB_MS = 30 * 60 * 1000;      // 30分
const COOLDOWN_TICKET_MS = 60 * 60 * 1000;   // 1時間
const COOLDOWN_ARASHI_MS = 60 * 60 * 1000;   // 1時間

const ROLE_ADD_COST = 10000;

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

// 午前0時のリセット処理
function resetAllData() {
    userBalance.clear();
    userCooldowns.clear();
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
].map(command => command.toJSON());

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent 
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
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    const userId = interaction.user.id;
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
            default:
                const unknownEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('❌ エラー')
                    .setDescription('不明なコマンドです。')
                    .setTimestamp();
                await interaction.reply({ embeds: [unknownEmbed], ephemeral: true });
        }
    } catch (error) {
        console.error('コマンド実行中にエラーが発生しました:', error);
        const errorEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('⚠️ 予期せぬエラー')
            .setDescription('コマンド実行中に予期せぬエラーが発生しました。時間を置いて再度お試しください。')
            .setTimestamp();
            
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        } else if (interaction.deferred) {
             await interaction.editReply({ embeds: [errorEmbed] });
        }
    }
});

// --- コマンド実行ヘルパー関数 ---

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
    const errorEmbed = (description) => new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 送信失敗').setDescription(description).setTimestamp();
    
    await interaction.deferReply({ ephemeral: true });

    const channel = client.channels.cache.get(TICKET_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ 
            embeds: [errorEmbed(`設定されたチケットチャンネル（ID: \`${TICKET_CHANNEL_ID}\`）が見つからないか、テキストチャンネルではありません。`)], 
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
            embeds: [errorEmbed('メッセージの送信中にエラーが発生しました。ボットの権限（Webhookの管理）を確認してください。')] 
        });
    }
}

async function handleArashiTeikyo(interaction, userId) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const adminErrorEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 権限エラー').setDescription('このコマンドは管理者のみ実行できます。').setTimestamp();
        return interaction.reply({ embeds: [adminErrorEmbed], ephemeral: true });
    }

    if (await checkCooldown(interaction, userId, '荒らし提供', COOLDOWN_ARASHI_MS, 'arashi_teikyo')) return;

    const url = interaction.options.getString('url');
    const errorEmbed = (description) => new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 送信失敗').setDescription(description).setTimestamp();
    
    await interaction.deferReply({ ephemeral: true });

    const channel = client.channels.cache.get(ARASHI_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ 
            embeds: [errorEmbed(`設定された提供チャンネル（ID: \`${ARASHI_CHANNEL_ID}\`）が見つからないか、テキストチャンネルではありません。`)], 
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
            embeds: [errorEmbed('メッセージの送信中にエラーが発生しました。ボットの権限（Webhookの管理）を確認してください。')] 
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
    
    const errorEmbed = (description) => new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 強盗失敗').setDescription(description).setTimestamp();
    const warningEmbed = (description) => new EmbedBuilder().setColor(0xFFFF00).setTitle('⚠️ 強盗不可').setDescription(description).setTimestamp();


    if (targetUser.id === userId) {
        return interaction.reply({ embeds: [errorEmbed('自分自身を盗むことはできません！')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('ボットからは盗めません。')], ephemeral: true });
    }

    const targetBalance = getBalance(targetUser.id);

    if (targetBalance < 100) {
        return interaction.reply({ embeds: [warningEmbed(`${targetUser.username} は貧しいようです。盗むには最低100コイン必要です。`)], ephemeral: true });
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
    const errorEmbed = (title, description) => new EmbedBuilder().setColor(0xFF0000).setTitle(title).setDescription(description).setTimestamp();
    
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ 
            embeds: [errorEmbed('❌ 権限不足', 'ボットにロールを管理する権限がありません。管理者にご確認ください。')], 
            ephemeral: true 
        });
    }

    if (currentBalance < ROLE_ADD_COST) {
        return interaction.reply({ 
            embeds: [errorEmbed('💰 コイン不足', `ロール作成には **${ROLE_ADD_COST.toLocaleString()}** コイン必要です。`)], 
            ephemeral: true 
        });
    }

    const roleName = interaction.options.getString('name');
    let roleColor = interaction.options.getString('color') || 'DEFAULT';

    if (roleColor !== 'DEFAULT' && !/^#?[0-9A-F]{6}$/i.test(roleColor)) {
        return interaction.reply({ 
            embeds: [errorEmbed('🎨 不正な色コード', '色の指定は有効な16進数カラーコード（例: FF0000 または #FF0000）である必要があります。')], 
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
        const failureEmbed = errorEmbed('⚠️ 処理失敗', 'ロールの作成または付与に失敗しました。ボットの権限設定（ロールがボットより上位でないかなど）を確認してください。');
        await interaction.editReply({ embeds: [failureEmbed] });
    }
}

async function handleAdminMoney(interaction, isAdd) {
    const targetUser = interaction.options.getUser('user');
    const targetRole = interaction.options.getRole('role');
    const amount = interaction.options.getInteger('money');
    const action = isAdd ? '追加' : '削減';
    const color = isAdd ? 0x00FF00 : 0xFF0000;
    
    const adminErrorEmbed = (description) => new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 権限エラー').setDescription(description).setTimestamp();
    const inputErrorEmbed = (description) => new EmbedBuilder().setColor(0xFF8C00).setTitle('⚠️ 入力エラー').setDescription(description).setTimestamp();

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ embeds: [adminErrorEmbed('このコマンドは管理者のみ実行できます。')], ephemeral: true });
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
            const fetchErrorEmbed = adminErrorEmbed('ロールメンバーの取得エラー', 'ロールメンバーの取得中にエラーが発生しました。');
            return interaction.editReply({ embeds: [fetchErrorEmbed] });
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

    const errorEmbed = (description) => new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 送金失敗').setDescription(description).setTimestamp();

    if (targetUser.id === userId) {
        return interaction.reply({ embeds: [errorEmbed('自分自身に送金することはできません。')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('ボットに送金することはできません。')], ephemeral: true });
    }

    if (currentBalance < amount) {
        return interaction.reply({ 
            embeds: [errorEmbed(`送金に必要な **${amount.toLocaleString()}** コインが足りません。`)
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
