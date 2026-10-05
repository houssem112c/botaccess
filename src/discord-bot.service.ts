import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    GuildMember,
    Interaction,
    ModalBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import { PrismaService } from './prisma.service.js';

const VERIFY_BUTTON_ID = 'verify_access_button';
const VERIFY_MODAL_ID = 'verify_access_modal';
const VERIFY_INPUT_ID = 'access_code';
const VERIFIED_ROLE_ID = process.env.DISCORD_VERIFIED_ROLE_ID;
const UNVERIFIED_ROLE_ID = process.env.DISCORD_UNVERIFIED_ROLE_ID;
const GENERATE_COMMAND = new SlashCommandBuilder()
  .setName('generate-code')
  .setDescription('Generate one or more access codes')
  .addIntegerOption((option) =>
    option
      .setName('amount')
      .setDescription('Number of codes to generate')
      .setMinValue(1)
      .setMaxValue(100),
  );

@Injectable()
export class DiscordBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordBotService.name);
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      this.logger.warn('DISCORD_TOKEN is not set; Discord bot will not start.');
      return;
    }

    this.registerEventHandlers();
    await this.registerCommands();
    await this.client.login(token);
  }

  async onModuleDestroy() {
    if (this.client.isReady()) {
      await this.client.destroy();
    }
  }

  private registerEventHandlers() {
    this.client.once(Events.ClientReady, async () => {
      this.logger.log(`Logged in as ${this.client.user?.tag ?? 'unknown bot'}`);
    });

    this.client.on(Events.GuildMemberAdd, async (member) => {
      try {
        await this.assignUnverifiedRole(member);
        await this.publishVerificationMessage(member);
      } catch (error) {
        this.logger.error('Failed to send verification DM on member join', error as Error);
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        await this.handleInteraction(interaction);
      } catch (error) {
        this.logger.error('Failed to handle Discord interaction', error as Error);
      }
    });
  }

  private async registerCommands() {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const guildId = process.env.DISCORD_GUILD_ID;

    if (!clientId) {
      this.logger.warn('DISCORD_CLIENT_ID is not set; slash commands were not registered.');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN ?? '');
    const commands = [GENERATE_COMMAND.toJSON()];

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      this.logger.log('Registered guild slash commands.');
      return;
    }

    await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });
    this.logger.log('Registered global slash commands.');
  }

  private async publishVerificationMessage(member: GuildMember) {
    const message = new EmbedBuilder()
      .setTitle('Server Verification')
      .setDescription(
        `Welcome, ${member.displayName}!\n\nTo access the server, you need a valid access code.\n\nYour code can only be used once.`,
      )
      .setColor(0x5865f2);

    const button = new ButtonBuilder()
      .setCustomId(VERIFY_BUTTON_ID)
      .setLabel('Verify Access')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    await member.send({
      embeds: [message],
      components: [row],
    });
  }

  private async assignUnverifiedRole(member: GuildMember) {
    if (!UNVERIFIED_ROLE_ID) {
      return;
    }

    try {
      await member.roles.add(UNVERIFIED_ROLE_ID);
    } catch (error) {
      this.logger.warn(`Unverified role could not be assigned for user ${member.user.id}.`, error as Error);
    }
  }

  private async handleInteraction(interaction: Interaction) {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'generate-code') {
        await this.handleGenerateCode(interaction);
      }

      return;
    }

    if (interaction.isButton() && interaction.customId === VERIFY_BUTTON_ID) {
      await this.presentVerificationModal(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === VERIFY_MODAL_ID) {
      await this.verifySubmittedCode(interaction);
    }
  }

  private async presentVerificationModal(interaction: Interaction) {
    if (!interaction.isButton()) {
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(VERIFY_MODAL_ID)
      .setTitle('Verify Access');

    const input = new TextInputBuilder()
      .setCustomId(VERIFY_INPUT_ID)
      .setLabel('Enter your access code')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(64);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);

    modal.addComponents(row);
    await interaction.showModal(modal);
  }

  private async verifySubmittedCode(interaction: Interaction) {
    if (!interaction.isModalSubmit()) {
      return;
    }

    const code = interaction.fields.getTextInputValue(VERIFY_INPUT_ID).trim();
    const accessCode = await this.prisma.accessCode.findUnique({
      where: { code },
    });

    if (!accessCode || accessCode.used) {
      await interaction.reply({
        content: 'That code is invalid or has already been used.',
        ephemeral: true,
      });
      return;
    }

    await this.prisma.accessCode.update({
      where: { code },
      data: {
        used: true,
        usedBy: interaction.user.id,
        usedAt: new Date(),
      },
    });

    if (interaction.inGuild() && VERIFIED_ROLE_ID) {
      try {
        const guild = interaction.guild;
        if (!guild) {
          return;
        }

        const member = await guild.members.fetch(interaction.user.id);
        await member.roles.add(VERIFIED_ROLE_ID);
        if (UNVERIFIED_ROLE_ID) {
          await member.roles.remove(UNVERIFIED_ROLE_ID);
        }
      } catch (error) {
        this.logger.warn(`Verified role could not be assigned for user ${interaction.user.id}.`, error as Error);
      }
    }

    await interaction.reply({
      content: VERIFIED_ROLE_ID ? 'Verified and access role granted.' : 'Verified.',
      ephemeral: true,
    });
  }

  private async handleGenerateCode(interaction: Interaction) {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const amount = interaction.options.getInteger('amount') ?? 1;
    const codes: string[] = [];

    while (codes.length < amount) {
      const code = this.generateCode();
      const created = await this.prisma.accessCode.createMany({
        data: [{ code }],
        skipDuplicates: true,
      });

      if (created.count === 1) {
        codes.push(code);
      }
    }

    await interaction.reply({
      content: `Generated code${codes.length === 1 ? '' : 's'}:\n${codes.join('\n')}`,
      ephemeral: true,
    });
  }

  private generateCode() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const segment = (length: number) => {
      const bytes = randomBytes(length);
      return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
    };

    return `${segment(4)}-${segment(4)}-${segment(4)}`;
  }
}