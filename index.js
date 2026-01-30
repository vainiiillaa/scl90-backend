const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 核心中间件 ---
app.use(cors());
app.use(express.json());

// --- 1. 初始化和连接 Redis 数据库 ---
let redisClient;
(async () => {
    try {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
            console.warn("REDIS_URL is not set. Redemption code feature will not work.");
            return;
        }
        redisClient = createClient({ url: redisUrl });
        redisClient.on('error', (err) => console.error('Redis Client Error', err));
        await redisClient.connect();
        console.log('Successfully connected to Redis!');
    } catch (error) {
        console.error('Could not connect to Redis:', error);
    }
})();

// --- 2. 兑换码验证和授权逻辑 (完整版) ---
app.post('/api/validate-code', async (req, res) => {
    const { code } = req.body;
    if (!redisClient || !redisClient.isReady) {
        return res.status(503).json({ error: '数据库服务暂不可用，请稍后再试。' });
    }
    try {
        const codeExists = await redisClient.get(`code:${code}`);
        if (codeExists) {
            await redisClient.del(`code:${code}`); // 兑换码一次性使用
            const tempToken = uuidv4(); // 生成一个临时通行证
            await redisClient.set(`token:${tempToken}`, 'valid', { EX: 3600 }); // 通行证1小时有效
            res.json({ success: true, tempToken: tempToken });
        } else {
            res.status(404).json({ error: '无效或已使用的兑换码。' });
        }
    } catch (error) {
        console.error('Code validation error:', error);
        res.status(500).json({ error: '服务器内部错误。' });
    }
});

// [可选] 为你提供一个生成测试兑换码的接口
// 部署后，访问 https://你的后端地址.onrender.com/api/generate-code 即可获取
app.get('/api/generate-code', async (req, res) => {
    if (!redisClient || !redisClient.isReady) {
        return res.status(503).json({ error: '数据库服务暂不可用。' });
    }
    try {
        const newCode = uuidv4().slice(0, 6).toUpperCase();
        await redisClient.set(`code:${newCode}`, 'active');
        res.send(`<h1>新的兑换码已生成: ${newCode}</h1><p>请在24小时内使用。</p>`);
    } catch (error) {
        res.status(500).json({ error: '生成码时出错。' });
    }
});


const authMiddleware = async (req, res, next) => {
    const token = req.headers['x-auth-token'];
    if (!token) {
        return res.status(401).json({ error: '未提供授权凭证。' });
    }
    if (!redisClient || !redisClient.isReady) {
        return res.status(503).json({ error: '数据库服务暂不可用。' });
    }
    try {
        const tokenIsValid = await redisClient.get(`token:${token}`);
        if (tokenIsValid) {
            await redisClient.del(`token:${token}`); // 临时通行证也是一次性的
            next();
        } else {
            res.status(403).json({ error: '授权凭证无效或已过期。' });
        }
    } catch (error) {
        res.status(500).json({ error: '服务器内部错误。' });
    }
};


// --- 3. SCL-90 分析引擎 (Final Bugfix Version) ---

const SCL90_FACTORS = {
    "躯体化": [1, 4, 12, 27, 40, 42, 48, 49, 52, 53, 56, 58],
    "强迫症状": [3, 9, 10, 28, 38, 45, 46, 51, 55, 65],
    "人际关系敏感": [6, 21, 34, 36, 37, 41, 61, 69, 73],
    "抑郁": [5, 14, 15, 20, 22, 26, 29, 30, 31, 32, 54, 71, 79],
    "焦虑": [2, 17, 23, 33, 39, 57, 72, 78, 80, 86],
    "敌对": [11, 24, 63, 67, 74, 81],
    "恐怖": [13, 25, 47, 50, 70, 75, 82],
    "偏执": [8, 18, 43, 68, 76, 83],
    "精神病性": [7, 16, 35, 62, 77, 84, 85, 87, 88, 90]
};

const KNOWLEDGE_BASE = {
    "躯体化": {
        "normal": { symptoms: "您在身体感觉方面表现平稳，能很好区分生理不适与情绪波动，这是身心健康的良好标志。", advice: "请继续保持对身体信号的觉察，结合规律作息和适度锻炼，是维持身心平衡的最佳方式。" },
        "mild": { symptoms: "您可能偶尔会感到一些无法解释的身体不适，如头痛、乏力，这些有时是情绪压力的早期信号。", advice: "尝试增加放松活动，如散步、听音乐或正念冥想。记录不适感出现的情境，有助于理解其与情绪的关联。" },
        "moderate": { symptoms: "您似乎比较频繁地体验到身体上的困扰，这些不适感可能开始影响您的日常生活和精力。", advice: "建议您关注情绪的调节，学习压力管理技巧。与信任的朋友倾诉，或进行温和的运动如瑜伽，可能带来缓解。" },
        "severe": { symptoms: "您可能正被持续的、多样化的身体不适所困扰，严重影响了生活质量。", advice: "强烈建议您进行一次全面的身体检查以排除生理问题。同时，与心理咨询师探讨这些症状背后的情绪根源是至关重要的一步。" },
        "extreme": { symptoms: "您可能正经历着剧烈且广泛的躯体化症状，让您极度痛苦和焦虑，难以正常工作或生活。", advice: "请务必立即寻求医疗和心理健康的双重专业帮助。专业的支持是此刻最重要、最紧急的事情。" }
    },
    "强迫症状": {
        "normal": { symptoms: "您的思维清晰且富有弹性，能够很好地控制无意义的重复想法或行为，专注于重要的事情。", advice: "保持开放和接纳的心态，允许思维的自然流动，这是预防强迫思维的有效方法。" },
        "mild": { symptoms: "您可能偶尔会反复检查或思考某些事情，但这些通常不会严重干扰您的生活。这可能是压力增大时的一种表现。", advice: "当觉察到重复想法时，尝试深呼吸并温和地将注意力转移到当前的任务上。练习正念有助于减少不必要的思维纠缠。" },
        "moderate": { symptoms: "某些不必要的想法或行为可能已开始困扰您，您需要花费一些精力去抵抗它们，这可能让您感到疲惫。", advice: "尝试“延迟满足”技巧，当有强迫冲动时，告诉自己“等15分钟再做”。同时，增加体育锻炼可以有效释放心理能量。" },
        "severe": { symptoms: "您可能正与强烈的、侵入性的强迫思维或行为作斗争，它们占据了您大量的时间和精力，并可能导致明显的焦虑。", advice: "与专业的心理咨询师讨论认知行为疗法（CBT）中的暴露与反应预防（ERP）技术，这是应对强迫症状非常有效的方法。" },
        "extreme": { symptoms: "强迫思维和行为可能已经严重主导了您的生活，让您感到极度痛苦和功能受损，难以自拔。", advice: "刻不容缓，请立即寻求精神科医生和心理治疗师的专业帮助。药物治疗结合心理治疗通常能带来显著的改善。" }
    },
    "人际关系敏感": {
        "normal": { symptoms: "您在人际交往中感到自信和舒适，能够客观地解读他人的言行，拥有健康的个人边界。", advice: "继续珍视和维护您健康的人际关系网络，这是宝贵的社会支持系统。" },
        "mild": { symptoms: "您可能偶尔会过度解读他人的言行，或在社交场合感到些许不自在，但通常能够很快调整过来。", advice: "在与人交往后，尝试客观地复盘，区分“事实”和自己的“猜测”。练习自我肯定，减少对他人评价的依赖。" },
        "moderate": { symptoms: "您可能时常感到别人在评论或否定自己，容易在关系中感到受伤或不被理解，并可能因此回避社交。", advice: "学习建立健康的个人边界，并练习直接而温和地表达自己的感受和需求。阅读一些关于人际沟通的书籍会很有帮助。" },
        "severe": { symptoms: "您可能对他人评价感到极度敏感和痛苦，常常感到自卑、被孤立，人际交往成为一种沉重的负担。", advice: "与心理咨询师一起探讨这种敏感背后可能存在的深层原因，如早年经历或核心信念，是解决问题的关键。" },
        "extreme": { symptoms: "您可能长期处于人际关系的痛苦和恐惧中，深刻的自卑感和不信任感让您难以建立和维持健康的链接。", advice: "专业的心理治疗可以帮助您重建安全感和自我价值感。这是一个需要耐心和专业支持的过程，请勇敢迈出第一步。" }
    },
    "抑郁": {
        "normal": { symptoms: "您情绪稳定，对生活充满兴趣和活力，能够从日常活动中获得乐趣和满足感。", advice: "保持积极的生活习惯和社交联系，这些是预防情绪低落的“心理疫苗”。" },
        "mild": { symptoms: "您可能偶尔会感到情绪低落、缺乏动力或对平时喜欢的事物失去兴趣，但这些感觉通常是短暂的。", advice: "确保充足的睡眠和规律的饮食。有意识地安排一些能给自己带来愉悦感的活动，即使当下并不想做。" },
        "moderate": { symptoms: "您可能持续一段时间感到情绪低落、空虚或悲伤，对未来感到悲观，生活动力显著下降。", advice: "将您的感受告诉信任的人非常重要。进行规律的有氧运动，如快走或跑步，已被证明能有效改善抑郁情绪。" },
        "severe": { symptoms: "您可能正被强烈的悲伤、无价值感和绝望感所笼罩，日常功能（如工作、学习）受到严重影响。", advice: "寻求心理咨询师或治疗师的帮助是当前非常必要的选择。他们能提供专业的支持和有效的干预策略。" },
        "extreme": { symptoms: "您可能正经历着极度的情绪痛苦，甚至可能出现自我伤害或自杀的想法，感到生活失去了所有意义。", advice: "这是一个紧急情况！请立即联系危机干预热线、精神科医生或前往医院急诊。您不是一个人，专业的帮助可以立刻介入。" }
    },
    "焦虑": {
        "normal": { symptoms: "您能以平静和专注的心态应对生活中的挑战，没有过度的担忧和紧张感。", advice: "继续练习活在当下的能力，正念和冥想是保持内心平静的绝佳工具。" },
        "mild": { symptoms: "您可能偶尔会感到紧张、担忧或心神不宁，尤其是在面对压力事件时，但能够自行调节。", advice: "学习一些简单的放松技巧，如腹式呼吸或渐进式肌肉放松，可以在感到焦虑时快速帮助自己平静下来。" },
        "moderate": { symptoms: "您可能时常感到莫名的紧张和恐惧，身体也可能出现心慌、手抖等反应，担忧感开始影响您的注意力。", advice: "尝试限制咖啡因和糖分的摄入，它们可能会加剧焦虑感。建立一个规律的“担忧时间”，每天固定15分钟去思考，其余时间则“放下”。" },
        "severe": { symptoms: "您可能长期处于高度警觉和担忧的状态，难以放松，身体和精神都感到非常疲惫，并可能开始回避引发焦虑的场景。", advice: "认知行为疗法（CBT）对于处理焦虑症状非常有效。请咨询专业的心理治疗师，学习识别和挑战导致焦虑的非理性思维。" },
        "extreme": { symptoms: "您可能正被强烈的、持续的恐惧和惊恐感所淹没，甚至可能经历惊恐发作，感觉自己即将失控或死去。", advice: "请立即寻求精神科医生的帮助。药物治疗结合心理治疗通常能非常有效地控制严重的焦虑症状，让您重获安宁。" }
    },
    "敌对": {
        "normal": { symptoms: "您能以平和理性的方式处理人际冲突和不同意见，即使在感到愤怒时也能进行有效的沟通。", advice: "您健康的愤怒管理能力是良好人际关系的基础，请继续保持这种成熟的处理方式。" },
        "mild": { symptoms: "您可能偶尔会感到烦躁、易怒，或在内心对他人的行为感到不满，但通常能够控制自己的言行。", advice: "当感到愤怒时，尝试暂停一下，给自己一个冷静的空间。用“我”开头来表达自己的感受，而不是指责对方。" },
        "moderate": { symptoms: "您可能比较容易被激怒，时常与人发生争论，内心积压着一些怨恨和不满的情绪。", advice: "寻找健康的渠道来释放愤怒情绪，如体育运动、写作或艺术创作。学习识别愤怒背后的真实需求是关键。" },
        "severe": { symptoms: "您可能内心充满愤怒和敌意，对他人的动机抱有怀疑和不信任，人际关系因此变得紧张和充满冲突。", advice: "与心理咨询师一起探讨您愤怒模式的根源，并学习更具建设性的冲突解决方法，这对改善您的人际环境至关重要。" },
        "extreme": { symptoms: "您可能难以控制自己的攻击性冲动，言语或行为上可能表现出破坏性，内心充满怨恨和报复的想法。", advice: "这是一个需要严肃对待的信号。请务必寻求专业的心理干预，学习情绪调节和冲动控制技巧，以保护自己和他人。" }
    },
    "恐怖": {
        "normal": { symptoms: "您能够坦然面对各种社交场合、特定物体或情境，没有非理性的恐惧感。", advice: "您拥有健康的心理适应能力，能够自由地探索和体验生活的各种可能性。" },
        "mild": { symptoms: "您可能对某些特定事物或情境（如高处、人群）感到轻微的紧张或不适，但能够应对，不会刻意回避。", advice: "逐步、温和地接触让您感到轻微不适的事物，可以帮助您建立信心，防止恐惧感加深。" },
        "moderate": { symptoms: "您对某些特定情境存在明显的恐惧感，并可能开始有意识地回避它们，这在一定程度上限制了您的活动范围。", advice: "了解并学习系统脱敏疗法的原理会对您有帮助。在安全和可控的环境下，从想象开始，逐步接近恐惧对象。" },
        "severe": { symptoms: "您可能被一种或多种强烈的、非理性的恐惧所困扰，并为此付出了巨大的回避努力，严重影响了您的正常生活。", advice: "专业的心理治疗，特别是暴露疗法，是处理恐怖症状最有效的方法。请不要独自挣扎，寻求咨询师的帮助。" },
        "extreme": { symptoms: "强烈的恐怖感可能让您长期处于回避和恐惧的状态，生活空间被极度压缩，内心充满无助和恐慌。", advice: "请寻求精神科医生和心理治疗师的帮助。这是一种可以被有效治疗的状况，专业的支持能帮您重获自由。" }
    },
    "偏执": {
        "normal": { symptoms: "您能够信任他人，客观地看待问题，不会无端怀疑他人的动机，人际关系轻松和谐。", advice: "健康的信任能力是建立深度人际关系的基础，这是您非常宝贵的心理财富。" },
        "mild": { symptoms: "您可能偶尔会对他人的意图产生怀疑，或感觉自己被不公平对待，但能够通过沟通和事实来消除疑虑。", advice: "在产生怀疑时，主动、开放地与对方沟通，澄清事实，是避免误解升级的最佳方式。" },
        "moderate": { symptoms: "您可能时常感到不被信任或被他人针对，内心有一定的戒备和疏离感，难以真正地对人敞开心扉。", advice: "尝试练习“善意解读”，在没有明确证据前，先假设对方是出于好意。这有助于打破怀疑的循环。" },
        "severe": { symptoms: "您可能坚信自己是他人敌意或阴谋的对象，内心充满怀疑、警惕和不安全感，难以维持稳定的人际关系。", advice: "与心理咨询师一起工作，探讨这些不信任感的来源，并学习如何基于证据而非感觉来判断现实，是极其重要的一步。" },
        "extreme": { symptoms: "您可能被一个系统化的、坚信不疑的被害信念所困扰，感觉自己时刻处于危险之中，并可能因此与现实脱节。", advice: "请务必寻求精神科医生的专业评估和帮助。这是一个需要药物和心理治疗共同干预的严肃状况。" }
    },
    "精神病性": {
        "normal": { symptoms: "您的思想清晰，感知真实，能够很好地融入现实生活，与他人有共同的现实感。", advice: "您拥有稳固的现实检验能力，这是心理健康的重要基石。" },
        "mild": { symptoms: "您可能偶尔会有一些奇特的想法或感觉，但您清楚地知道那只是自己的想象，不会将其与现实混淆。", advice: "保持开放的好奇心，同时扎根于现实生活，多与人交流，参与具体的活动，有助于保持思维的清晰度。" },
        "moderate": { symptoms: "您可能有时会感到思维混乱，或有一些脱离现实的想法，让您感到困惑和不安，社交上也可能感到孤立。", advice: "保证充足的睡眠和休息，避免使用酒精和药物，这些对于维持思维的稳定性至关重要。与信任的人分享您的困惑感。" },
        "severe": { symptoms: "您可能开始难以区分内心想法和外部现实，出现一些歪曲的信念或感知体验，让您和身边的人都感到担忧。", advice: "请尽快寻求精神科医生的专业评估。及早的干预对于控制症状、防止其进一步发展至关重要。" },
        "extreme": { symptoms: "您可能正经历着明显的幻觉、妄想等症状，思维和行为与现实脱节，个人功能严重受损。", advice: "这是一个医疗紧急情况。请立即在家人的陪同下前往精神卫生中心或医院就诊，专业的治疗是恢复的唯一途径。" }
    }
};

function getFactorStatus(score) {
    if (score < 1.5) return { level: "normal", text: "正常", color: "#28a745" };
    if (score < 2.5) return { level: "mild", text: "轻度", color: "#ffc107" };
    if (score < 3.5) return { level: "moderate", text: "中度", color: "#fd7e14" };
    if (score < 4.5) return { level: "severe", text: "偏重", color: "#dc3545" };
    return { level: "extreme", text: "严重", color: "#a21222" };
}

function getOverallStatus(averageScore) {
    if (averageScore < 1.5) {
        return { text: "正常", color: "#28a745" };
    } else if (averageScore < 2.5) {
        return { text: "轻度", color: "#ffc107" };
    } else if (averageScore < 3.5) {
        return { text: "中度", color: "#fd7e14" };
    } else if (averageScore < 4.5) {
        return { text: "偏重", color: "#dc3545" };
    } else {
        return { text: "严重", color: "#a21222" };
    }
}

app.post('/api/submit', authMiddleware, (req, res) => {
    try {
        const { answers } = req.body;
        if (!answers || !Array.isArray(answers) || answers.length !== 90) {
            return res.status(400).json({ error: "提交的数据格式不正确。" });
        }

        const answerMap = new Map(answers.map(a => [String(a.id), parseInt(a.score, 10) || 0]));
        
        const totalScore = Array.from(answerMap.values()).reduce((sum, score) => sum + score, 0);
        const itemAverageScore = (totalScore / 90).toFixed(2);
        
        let positiveFactorCount = 0;
        const factorDetails = Object.entries(SCL90_FACTORS).map(([name, ids]) => {
            const factorTotalScore = ids.reduce((sum, id) => sum + (answerMap.get(String(id)) || 0), 0);
            const factorAverageScore = (factorTotalScore / ids.length); // **修复点1**：先不取整，保证精度
            const status = getFactorStatus(factorAverageScore);
            
            if (status.level !== "normal") positiveFactorCount++;
            
            return { name, totalScore: factorTotalScore, averageScore: factorAverageScore, status };
        });

        const stats = {
            totalScore,
            itemAverageScore: parseFloat(itemAverageScore),
            positiveFactorCount,
            positiveFactorPercentage: ((positiveFactorCount / 9) * 100).toFixed(0) + "%"
        };

        const overallAssessment = getOverallStatus(stats.itemAverageScore);
        
        const detailedExplanations = factorDetails.map(factor => {
            // **【关键修复】** 确保查找时使用正确的level键
            const knowledge = KNOWLEDGE_BASE[factor.name][factor.status.level];
            if (!knowledge) {
                // 添加一个保险措施，防止因为意外的level值而崩溃
                console.error(`Missing knowledge base entry for factor: ${factor.name}, level: ${factor.status.level}`);
                return { name: factor.name, status: factor.status, symptoms: "解读信息缺失。", advice: "请联系管理员。" };
            }
            return { name: factor.name, status: factor.status, symptoms: knowledge.symptoms, advice: knowledge.advice };
        });
        
        res.json({ stats, overallAssessment, factorDetails, detailedExplanations });

    } catch (error) {
        console.error("CRITICAL ERROR during submission processing:", error);
        res.status(500).json({ error: "服务器在分析您的结果时发生内部错误。" });
    }
});



// --- 4. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
