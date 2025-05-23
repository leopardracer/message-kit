import { Skill, Context } from "@xmtp/message-kit";
import { getUserInfo } from "@xmtp/agent-starter";
import { getRedisClient } from "../plugins/redis.js";
import {
  checkTossCorrect,
  extractWinners,
  TossData,
  generateTossMessage,
  generateEndTossMessage,
  generateTossStatusMessage,
} from "../plugins/helpers.js";

export const toss: Skill[] = [
  {
    skill: "end",
    description: "End a toss.",
    handler: handleEndToss,
    examples: ["/end yes", "/end no"],
    params: {
      option: {
        type: "string",
      },
    },
  },
  {
    skill: "cancel",
    description: "Cancel a toss.",
    handler: handleCancelToss,
    examples: ["/cancel"],
  },
  {
    skill: "join",
    description: "Join a toss.",
    params: {
      response: {
        type: "string",
      },
    },
    handler: handleJoinToss,
    examples: ["/join yes", "/join no"],
  },
  {
    skill: "status",
    description: "Check the status of the toss.",
    handler: handleTossStatus,
    examples: ["/status"],
  },
  {
    skill: "toss",
    description:
      "Create a toss with a description, options, amount and end time(optional).",
    handler: handleTossCreation,
    examples: [
      "/toss 'Shane vs John at pickeball' 'Yes,No' 10",
      "/toss 'Will argentina win the world cup' 'Yes,No' 10",
      "/toss 'Race to the end' 'Fabri,John' 10 @fabri",
      "/toss 'Will argentina win the world cup' 'Yes,No' 5 '27 Oct 2023 23:59:59 GMT'",
      "/toss 'Will the niks win on sunday?' 'Yes,No' 10 vitalik.eth '27 Oct 2023 23:59:59 GMT'",
      "/toss 'Will it rain tomorrow' 'Yes,No' 0",
    ],
    params: {
      description: {
        type: "quoted",
      },
      options: {
        default: "Yes, No",
        type: "quoted",
      },
      amount: {
        type: "number",
      },
      endTime: {
        type: "quoted",
        optional: true,
      },
    },
  },
];

export async function handleTossCreation(context: Context) {
  const {
    message: {
      content: { params },
      sender,
    },
    walletService,
    group,
    isDM,
  } = context;
  if (isDM) {
    await context.send({
      message: "This command can only be used in a group.",
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  }

  const tossDBClient = await getRedisClient();
  if (params.description && params.options && !isNaN(Number(params.amount))) {
    const keys = await tossDBClient.keys("*");
    let tossId = keys.length + 1;
    const isCreated = await walletService.createWallet(
      tossId + ":" + sender.address,
    );
    if (!isCreated) {
      await context.send({
        message: "Failed to create toss wallet",
        originalMessage: context.message,
        typeId: "reply",
      });
      return;
    }

    let tossData: TossData = {
      toss_id: tossId.toString(),
      description: params.description,
      options: params.options,
      amount: params.amount,
      group_id: group?.id ?? "",
      admin_name: (await getUserInfo(sender.address))?.preferredName ?? "",
      admin_address: sender.address,
      creator_address: sender.address,
      created_at: new Date().toLocaleString(),
      end_time: params.endTime
        ? new Date(params.endTime).toLocaleString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleString(),
      participants: [],
    };
    await tossDBClient.set("toss:" + tossId, JSON.stringify(tossData));
    if (tossId !== undefined) {
      await context.send({
        message: generateTossMessage(tossData),
        originalMessage: context.message,
      });
    } else {
      await context.send({
        message: `An error occurred while creating the toss. ${tossId}`,
        originalMessage: context.message,
        typeId: "reply",
      });
    }
  }
}

export async function handleJoinToss(context: Context) {
  const tossData = await checkTossCorrect(context);
  if (!tossData) {
    return;
  }

  const { toss_id, participants, amount, admin_address } = tossData;

  const {
    message: {
      sender,
      content: {
        params: { response },
      },
    },
    walletService,
  } = context;

  const tossDBClient = await getRedisClient();
  if (participants?.some((p) => p.address === sender.address)) {
    await context.send({
      message: "You have already joined this toss.",
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  }
  const { balance } = await walletService.checkBalance(sender.address);
  if (balance < amount) {
    await context.executeSkill(`/fund ${amount}`);
    return;
  }
  try {
    let tempWalletID = toss_id + ":" + admin_address;
    const transfer = await walletService.transfer(
      sender.address,
      tempWalletID,
      amount,
    );
    if (transfer === undefined) {
      await context.send({
        message: "Failed to transfer funds to the toss wallet.",
        originalMessage: context.message,
        typeId: "reply",
      });
      return;
    }
    const participant = {
      address: sender.address,
      response: response,
      name:
        (await getUserInfo(sender.address))?.preferredName ?? sender.address,
    };
    participants.push(participant);

    await tossDBClient.set(
      `toss:${toss_id}`,
      JSON.stringify({ ...tossData, participants }),
    );

    await context.send({
      message: "Successfully joined the toss!",
      originalMessage: context.message,
      typeId: "reply",
    });

    await context.executeSkill(`/status ${toss_id}`);
  } catch (error) {
    console.error(error);
    await context.send({
      message: "Failed to process your entry. Please try again.",
      originalMessage: context.message,
      typeId: "reply",
    });
  }
}

export async function handleEndToss(context: Context) {
  const tossData = await checkTossCorrect(context);
  if (!tossData) return;
  const { toss_id, admin_address, options, participants } = tossData;

  const {
    message: {
      sender,
      content: {
        params: { option },
      },
    },
    walletService,
  } = context;

  const tossDBClient = await getRedisClient();
  if (participants?.length === 0) {
    await context.send({
      message: "No participants for this toss.",
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  } else if (admin_address.toLowerCase() !== sender.address.toLowerCase()) {
    await context.send({
      message: "Only the admin can cancel the toss.",
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  }

  let tempWalletID = toss_id + ":" + admin_address;
  const { balance } = await walletService.checkBalance(tempWalletID);
  const fundsNeeded = tossData.amount * participants?.length;
  if (balance < fundsNeeded) {
    await context.send({
      message: `Toss wallet does not have enough funds ${fundsNeeded}, has ${balance}`,
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  }

  //Winners

  const { winners, losers } = await extractWinners(participants, option);

  const prize =
    (tossData.amount * (participants?.length ?? 0)) / (winners.length ?? 1);

  try {
    await context.send({
      message: "Sending prize to winners...",
      originalMessage: context.message,
    });
    for (const winner of winners) {
      await walletService.transfer(tempWalletID, winner.address, prize);
      await tossDBClient.set(
        `toss:${toss_id}`,
        JSON.stringify({ ...tossData, status: "closed" }),
      );
    }
    // Clean up
    //await walletService.deleteTempWallet(tossWalletRedis, tossId.toString());
    if (winners.length > 0) {
      await context.send({
        message: generateEndTossMessage(winners, losers, prize),
        originalMessage: context.message,
        typeId: "reply",
      });
    }

    await context.send({
      message: `You received $${prize} from the toss!`,
      originalMessage: context.message,
      receivers: winners.map((w) => w.address),
      typeId: "reply",
    });
  } catch (error) {
    await context.send({
      message: `Failed to send prize to ${winners.length} winners`,
      originalMessage: context.message,
      typeId: "reply",
    });
  }
}

export async function handleCancelToss(context: Context) {
  const tossData = await checkTossCorrect(context);
  if (!tossData) return;

  const { toss_id, admin_address, participants, amount } = tossData;

  const {
    message: { sender },
    walletService,
  } = context;

  const tossDBClient = await getRedisClient();
  if (participants?.length === 0) {
    await context.send({
      message: "No participants for this toss.",
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  } else if (admin_address.toLowerCase() !== sender.address.toLowerCase()) {
    await context.send({
      message: "Only the admin can cancel the toss.",
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  }

  let tempWalletID = toss_id + ":" + admin_address;
  const { balance } = await walletService.checkBalance(tempWalletID);
  const fundsNeeded = tossData.amount * participants?.length;
  if (balance < fundsNeeded) {
    await context.send({
      message: `Toss wallet does not have enough funds ${fundsNeeded}, has ${balance}`,
      originalMessage: context.message,
      typeId: "reply",
    });
    return;
  }
  for (const participant of participants) {
    try {
      await walletService.transfer(tempWalletID, participant.address, amount);
    } catch (error) {
      console.error(
        `Failed to send prize to ${participant.address} agent wallet`,
        error,
      );
      await context.send({
        message: `Failed to send prize to ${participant.address} agent wallet`,
        originalMessage: context.message,
        typeId: "reply",
      });
    }
  }

  // Clean up
  //await walletService.deleteTempWallet(tossWalletRedis, tossId.toString());

  await tossDBClient.set(
    `toss:${toss_id}`,
    JSON.stringify({ ...tossData, status: "cancelled" }),
  );

  await context.send({
    message: `Toss cancelled successfully.\nFunds distributed to participants:\n
    ${participants?.map((p) => `${p.name} - $${amount}`).join("\n")}`,
    receivers: participants.map((p) => p.address),
    originalMessage: context.message,
    typeId: "reply",
  });
}
export async function handleTossStatus(context: Context) {
  const tossData = await checkTossCorrect(context);
  if (!tossData) return;
  await context.send({
    message: await generateTossStatusMessage(tossData),
    originalMessage: context.message,
    typeId: "reply",
  });
}
