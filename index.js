require('dotenv').config();

const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    PermissionsBitField,
    ApplicationCommandOptionType,
    EmbedBuilder
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const userBalance = new Map();
const userCooldowns = new Map();

const COOLDOWN_WORK_MS = 60 * 60 * 1000;
const COOLDOWN_ROB_MS = 30 * 60 * 1000;

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
                        .setMinValue(1)))
].map(command => command.toJSON());

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
    ] 
});

client.once('ready', async () => {
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

    if (commandName !== 'economy') return;

    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const currentBalance = getBalance(userId);

    try {
        switch (subcommand) {
            case 'work':
                await handleWork(interaction, userId, currentBalance);
                break;
            case 'rob':
                await handleRob(interaction, userId, currentBalance);
                break;
            case 'balance':
                await interaction.reply({ 
                    content: `あなたの現在の残高は **${currentBalance.toLocaleString()}** コインです。`,
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
            default:
                await interaction.reply({ content: '不明なエコノミーコマンドです。', ephemeral: true });
        }
    } catch (error) {
        console.error('コマンド実行中にエラーが発生しました:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'コマンド実行中に予期せぬエラーが発生しました。', ephemeral: true });
        } else if (interaction.deferred) {
             await interaction.editReply({ content: 'コマンド実行中に予期せぬエラーが発生しました。' });
        }
    }
});

async function handleWork(interaction, userId, currentBalance) {
    const now = Date.now();
    const cooldownData = userCooldowns.get(userId) || {};
    const lastWork = cooldownData.work || 0;
    
    if (now < lastWork + COOLDOWN_WORK_MS) {
        const remaining = lastWork + COOLDOWN_WORK_MS - now;
        const timeRemaining = formatCooldown(remaining);

        return interaction.reply({ 
            content: `まだ疲れています。**${timeRemaining}** 後にまた仕事ができます。`, 
            ephemeral: true 
        });
    }

    const earnedMoney = Math.floor(Math.random() * (2500 - 1500 + 1)) + 1500;
    
    const newBalance = currentBalance + earnedMoney;
    updateBalance(userId, newBalance);

    userCooldowns.set(userId, { ...cooldownData, work: now });

    await interaction.reply({
        content: `💼 お疲れ様です！ **${earnedMoney.toLocaleString()}** コイン稼ぎました。\n現在の残高: **${newBalance.toLocaleString()}** コイン`
    });
}

async function handleRob(interaction, userId, currentBalance) {
    const targetUser = interaction.options.getUser('target');
    const now = Date.now();

    if (targetUser.id === userId) {
        return interaction.reply({ content: '自分自身を盗むことはできません！', ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ content: 'ボットからは盗めません。', ephemeral: true });
    }

    const targetBalance = getBalance(targetUser.id);

    if (targetBalance < 100) {
        return interaction.reply({ content: `${targetUser.username} は貧しいようです。盗むには最低100コイン必要です。`, ephemeral: true });
    }

    const cooldownData = userCooldowns.get(userId) || {};
    const lastRob = cooldownData.rob || 0;

    if (now < lastRob + COOLDOWN_ROB_MS) {
        const remaining = lastRob + COOLDOWN_ROB_MS - now;
        const timeRemaining = formatCooldown(remaining);
        return interaction.reply({ content: `まだ強盗のクールタイム中です。**${timeRemaining}** 待ってください。`, ephemeral: true });
    }

    const success = Math.random() < 0.5;

    let replyMessage;
    let newRobberBalance = currentBalance;
    let newTargetBalance = targetBalance;

    if (success) {
        const stealPercentage = Math.random() * (0.65 - 0.55) + 0.55;
        const stolenAmount = Math.floor(targetBalance * stealPercentage);
        
        newRobberBalance += stolenAmount;
        newTargetBalance -= stolenAmount;
        
        updateBalance(userId, newRobberBalance);
        updateBalance(targetUser.id, newTargetBalance);

        replyMessage = `🚨 **成功！** ${targetUser.username} から **${stolenAmount.toLocaleString()}** コインを盗みました！\nあなたの残高: **${newRobberBalance.toLocaleString()}** コイン`;

    } else {
        const lossPercentage = Math.random() * (0.70 - 0.60) + 0.60;
        const lossAmount = Math.floor(currentBalance * lossPercentage);

        newRobberBalance = Math.max(0, currentBalance - lossAmount);
        updateBalance(userId, newRobberBalance);

        replyMessage = `👮 **失敗...** 警察に見つかり、**${lossAmount.toLocaleString()}** コインを罰金として失いました。\nあなたの残高: **${newRobberBalance.toLocaleString()}** コイン`;
    }

    userCooldowns.set(userId, { ...cooldownData, rob: now });

    await interaction.reply({ content: replyMessage });
}

async function handleRoleAdd(interaction, userId, currentBalance) {
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ content: 'ボットにロールを管理する権限がありません。管理者にご確認ください。', ephemeral: true });
    }

    if (currentBalance < ROLE_ADD_COST) {
        return interaction.reply({ 
            content: `コインが足りません。ロール作成には **${ROLE_ADD_COST.toLocaleString()}** コイン必要です。`, 
            ephemeral: true 
        });
    }

    const roleName = interaction.options.getString('name');
    let roleColor = interaction.options.getString('color') || 'DEFAULT';

    if (roleColor !== 'DEFAULT' && !/^#?[0-9A-F]{6}$/i.test(roleColor)) {
        return interaction.reply({ content: '色の指定は有効な16進数カラーコード（例: FF0000 または #FF0000）である必要があります。', ephemeral: true });
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

        await interaction.editReply({
            content: `🎉 ロール **${roleName}** を **${ROLE_ADD_COST.toLocaleString()}** コインで購入し、付与しました。\n現在の残高: **${newBalance.toLocaleString()}** コイン`
        });

    } catch (error) {
        console.error('ロール作成エラー:', error);
        await interaction.editReply({ 
            content: 'ロールの作成または付与に失敗しました。ボットの権限設定（ロールがボットより上位でないかなど）を確認してください。' 
        });
    }
}

async function handleAdminMoney(interaction, isAdd) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'このコマンドは管理者のみ実行できます。', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const targetRole = interaction.options.getRole('role');
    const amount = interaction.options.getInteger('money');
    const action = isAdd ? '追加' : '削減';
    
    if (!targetUser && !targetRole) {
        return interaction.reply({ content: 'ユーザーまたはロールのいずれか一つを指定してください。', ephemeral: true });
    }
    if (targetUser && targetRole) {
        return interaction.reply({ content: 'ユーザーとロールを同時に指定することはできません。どちらか一つに絞ってください。', ephemeral: true });
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
            return interaction.editReply({ content: 'ロールメンバーの取得中にエラーが発生しました。', ephemeral: true });
        }
    }

    if (affectedCount === 0 && targetRole) {
        return interaction.editReply({ 
            content: `✅ 管理者操作: **${targetRole.name}** ロールには有効なメンバーが見つからなかったため、操作は実行されませんでした。`,
            ephemeral: true
        });
    }


    await interaction.editReply({
        content: `✅ 管理者操作: ${targetDescription} (${affectedCount}名) の残高から **${amount.toLocaleString()}** コインを${action}しました。`,
        ephemeral: true
    });
}

async function handleGive(interaction, userId, currentBalance) {
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('money');

    if (targetUser.id === userId) {
        return interaction.reply({ content: '自分自身に送金することはできません。', ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ content: 'ボットに送金することはできません。', ephemeral: true });
    }

    if (currentBalance < amount) {
        return interaction.reply({ content: `送金に必要な **${amount.toLocaleString()}** コインが足りません。現在の残高: **${currentBalance.toLocaleString()}** コイン`, ephemeral: true });
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

client.login(TOKEN);

client.on('error', err => {
    console.error('Discord Client Error:', err);
});
