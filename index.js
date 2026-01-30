const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 核心中间件 ---
app.use(cors());
app.use(express.json());

// --- 1. 初始化和连接 Redis 数据库 (无改动) ---
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

// --- 2. 兑换码及授权逻辑 (无改动) ---
app.post('/api/validate-code', async (req, res) => {
    const { code } = req.body;
    if (!redisClient || !redisClient.isReady) {
        return res.status(503).json({ error: '数据库服务暂不可用，请稍后再试。' });
    }
    try {
        const codeExists = await redisClient.get(`code:${code}`);
        if (codeExists) {
            await redisClient.del(`code:${code}`);
            const tempToken = uuidv4();
            await redisClient.set(`token:${tempToken}`, 'valid', { EX: 3600 });
            res.json({ success: true, tempToken: tempToken });
        } else {
            res.status(404).json({ error: '无效或已使用的兑换码。' });
        }
    } catch (error) {
        console.error('Code validation error:', error);
        res.status(500).json({ error: '服务器内部错误。' });
    }
});
app.get('/api/generate-code', async (req, res) => {
    if (!redisClient || !redisClient.isReady) { return res.status(503).json({ error: '数据库服务暂不可用。' }); }
    try {
        const newCode = uuidv4().slice(0, 6).toUpperCase();
        await redisClient.set(`code:${newCode}`, 'active');
        res.send(`<h1>新的兑换码已生成: ${newCode}</h1><p>请在24小时内使用。</p>`);
    } catch (error) { res.status(500).json({ error: '生成码时出错。' }); }
});
const authMiddleware = async (req, res, next) => {
    const token = req.headers['x-auth-token'];
    if (!token) { return res.status(401).json({ error: '未提供授权凭证。' }); }
    if (!redisClient || !redisClient.isReady) { return res.status(503).json({ error: '数据库服务暂不可用。' }); }
    try {
        const tokenIsValid = await redisClient.get(`token:${token}`);
        if (tokenIsValid) {
            await redisClient.del(`token:${token}`);
            next();
        } else {
            res.status(403).json({ error: '授权凭证无效或已过期。' });
        }
    } catch (error) {
        res.status(500).json({ error: '服务器内部错误。' });
    }
};

// --- 3. SCL-90 全新分析引擎 v2.0 ---

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

// --- 【核心改动 1】: 全新的四级因子评分标准函数 ---
function getFactorStatus(averageScore) {
    if (averageScore < 2) return { level: "normal", text: "正常", color: "#28a745" };
    if (averageScore < 3) return { level: "mild", text: "轻度", color: "#ffc107" };
    if (averageScore < 4) return { level: "moderate", text: "中度", color: "#fd7e14" };
    return { level: "severe", text: "重度", color: "#dc3545" };
}

// --- 【核心改动 2】: 全新的四级综合心理健康状态评估函数 ---
function getOverallStatus(totalScore, positiveItemCount, factorDetails) {
    // 规则 1: 正常状态 (最严格，优先判断)
    const allFactorsNormal = factorDetails.every(f => f.averageScore < 2);
    if (totalScore < 160 && positiveItemCount <= 43 && allFactorsNormal) {
        return { text: "正常状态", color: "#28a745" };
    }

    // 规则 4: 重度症状 (次优先判断，条件最宽泛的 AND)
    const hasSevereFactors = factorDetails.some(f => f.averageScore >= 4);
    if ((totalScore >= 300 || hasSevereFactors) && positiveItemCount > 80) {
        return { text: "重度症状", color: "#dc3545" };
    }

    // 规则 3: 中度症状
    const hasModerateFactors = factorDetails.some(f => f.averageScore >= 3 && f.averageScore < 4);
    if (((totalScore >= 200 && totalScore <= 299) || hasModerateFactors) && (positiveItemCount >= 60 && positiveItemCount <= 80)) {
        return { text: "中度症状", color: "#fd7e14" };
    }

    // 规则 2: 轻度症状 (作为默认的“有症状”基础级别)
    // 注意：这里包含了所有不满足上述严格条件，但又确实存在症状的情况
    const hasMildFactors = factorDetails.some(f => f.averageScore >= 2 && f.averageScore < 3);
     if (((totalScore >= 160 && totalScore <= 199) || hasMildFactors) && positiveItemCount < 60) {
        return { text: "轻度症状", color: "#ffc107" };
    }
    
    // 如果都不满足上述条件，但又不是“正常”，则根据总分和阳性项目数进行一个保守的“轻度”评估
    if (totalScore >= 160 || positiveItemCount > 43) {
        return { text: "轻度症状", color: "#ffc107" };
    }

    // 最后的保险措施，理论上应该被规则1覆盖
    return { text: "正常状态", color: "#28a745" };
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
        
        // --- 【核心改动 3.1】: 计算阳性项目数 (分数>=2) ---
        const positiveItemCount = Array.from(answerMap.values()).filter(score => score >= 2).length;

        const factorDetails = Object.entries(SCL90_FACTORS).map(([name, ids]) => {
            const factorTotalScore = ids.reduce((sum, id) => sum + (answerMap.get(String(id)) || 0), 0);
            const factorAverageScore = factorTotalScore / ids.length;
            // 使用新的四级标准
            const status = getFactorStatus(factorAverageScore);
            return { name, totalScore: factorTotalScore, averageScore: factorAverageScore, status };
        });

        // --- 【核心改动 3.2】: 更新统计数据为“阳性项目” ---
        // 注意：JSON的key保持不变，避免修改前端JS，但承载的数据已经是“阳性项目”了
        const stats = {
            totalScore,
            itemAverageScore: parseFloat(itemAverageScore),
            positiveFactorCount: positiveItemCount, // KEY不变, VALUE已是阳性项目数
            positiveFactorPercentage: ((positiveItemCount / 90) * 100).toFixed(0) + "%" // KEY不变, VALUE已是阳性项目占比
        };

        // 使用全新的、更复杂的评估函数
        const overallAssessment = getOverallStatus(totalScore, positiveItemCount, factorDetails);
        
        // 注意：知识库部分需要与新的四级标准(normal, mild, moderate, severe)对应
        // 这里需要您根据新的四级标准，重新整理和编写您的知识库文本
        // 为了程序能运行，我先做了一个临时的映射
        const detailedExplanations = factorDetails.map(factor => {
            const knowledge = KNOWLEDGE_BASE_V2[factor.name][factor.status.level];
            return { name: factor.name, status: factor.status, symptoms: knowledge.symptoms, advice: knowledge.advice };
        });
        
        res.json({ stats, overallAssessment, factorDetails, detailedExplanations });

    } catch (error) {
        console.error("CRITICAL ERROR during submission processing:", error);
        res.status(500).json({ error: "服务器在分析您的结果时发生内部错误。" });
    }
});

// 临时的四级知识库 (您需要根据专业知识完善这部分内容)
const KNOWLEDGE_BASE_V2 = { /* ... 省略，内容太长，放在文件末尾 ... */ };
// 复制原有的KNOWLEDGE_BASE内容，并调整为四级
Object.keys(SCL90_FACTORS).forEach(factor => {
    KNOWLEDGE_BASE_V2[factor] = {
        normal: { symptoms: "您在该方面表现平稳，心理状态健康。", advice: "请继续保持积极的生活方式。" },
        mild: { symptoms: "您可能偶尔会体验到一些轻微的困扰，这些通常是情绪压力的早期信号。", advice: "尝试增加放松活动，如散步、听音乐或与朋友倾诉。" },
        moderate: { symptoms: "您似乎比较频繁地体验到该方面的困扰，可能已开始影响您的日常生活。", advice: "建议您关注情绪的调节，学习压力管理技巧，必要时可寻求专业心理疏导。" },
        severe: { symptoms: "您可能正被该方面的问题严重困扰，严重影响了生活质量，内心可能感到痛苦和焦虑。", advice: "强烈建议您寻求专业的心理健康支持，与咨询师或医生探讨这些症状是至关重要的一步。" }
    };
});


// --- 4. 启动服务器 (无改动) ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});