import type { AggregatedData } from '../aggregator/index.js';

export interface CascadeRisk {
  symbol: string;
  riskScore: number;         // 0-100
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';
  factors: CascadeFactor[];
  prediction: CascadePrediction | null;
  timestamp: number;
}

export interface CascadeFactor {
  name: string;
  score: number;             // 0-100 contribution to risk
  weight: number;            // 0-1 importance weight
  value: number;             // Raw value
  threshold: number;         // Danger threshold
  description: string;
}

export interface CascadePrediction {
  direction: 'long_squeeze' | 'short_squeeze';
  probability: number;       // 0-1
  estimatedImpact: number;   // Estimated USD liquidation volume
  timeWindow: string;        // e.g., "4-12 hours"
  triggerPrice: number;      // Price level that could trigger cascade
  triggerDistance: number;   // Percentage from current price
}

// Thresholds based on historical cascade patterns (more realistic)
const THRESHOLDS = {
  // Funding rate thresholds (8h rate as decimal)
  // Normal range: -0.01% to +0.01% (neutral)
  // Elevated: 0.03% - 0.05%
  // High: 0.05% - 0.1%
  // Critical: > 0.1%
  FUNDING_NORMAL: 0.0001,      // 0.01%
  FUNDING_ELEVATED: 0.0003,    // 0.03%
  FUNDING_HIGH: 0.0005,        // 0.05%
  FUNDING_CRITICAL: 0.001,     // 0.1%

  // Open Interest thresholds (relative to history)
  OI_ELEVATED: 1.3,            // 30% above average
  OI_HIGH: 1.6,                // 60% above average
  OI_CRITICAL: 2.0,            // 100% above average

  // Cross-exchange funding divergence (more lenient)
  FUNDING_DIVERGENCE_NORMAL: 0.0001,  // 0.01%
  FUNDING_DIVERGENCE_HIGH: 0.0003,    // 0.03%
  FUNDING_DIVERGENCE_CRITICAL: 0.0005, // 0.05%

  // Price deviation between exchanges
  PRICE_DEVIATION_NORMAL: 0.001,  // 0.1%
  PRICE_DEVIATION_HIGH: 0.003,    // 0.3%
  PRICE_DEVIATION_CRITICAL: 0.005, // 0.5%

  // OI Concentration thresholds
  OI_CONCENTRATION_NORMAL: 0.4,   // 40% on one exchange is normal
  OI_CONCENTRATION_HIGH: 0.6,     // 60% is elevated
  OI_CONCENTRATION_CRITICAL: 0.8, // 80% is concerning
};

// Factor weights for overall risk calculation
const WEIGHTS = {
  FUNDING_RATE: 0.30,
  OI_LEVEL: 0.25,
  FUNDING_DIVERGENCE: 0.20,
  PRICE_DEVIATION: 0.15,
  OI_CONCENTRATION: 0.10,
};

export class CascadePredictor {
  private historicalOI: Map<string, number[]> = new Map();
  private readonly historyLength = 100;

  updateHistory(data: AggregatedData): void {
    for (const symbol of data.symbols) {
      const m = data.metrics[symbol];
      if (!m || m.totalOpenInterestValue === 0) continue;

      const history = this.historicalOI.get(symbol) || [];
      history.push(m.totalOpenInterestValue);

      if (history.length > this.historyLength) {
        history.shift();
      }

      this.historicalOI.set(symbol, history);
    }
  }

  analyze(data: AggregatedData): CascadeRisk[] {
    this.updateHistory(data);

    const risks: CascadeRisk[] = [];

    for (const symbol of data.symbols) {
      const m = data.metrics[symbol];
      if (!m) continue;

      const factors: CascadeFactor[] = [];

      // Factor 1: Funding Rate Level
      const fundingScore = this.scoreFundingRate(m.avgFundingRate);
      factors.push({
        name: 'Funding Rate',
        score: fundingScore,
        weight: WEIGHTS.FUNDING_RATE,
        value: m.avgFundingRate,
        threshold: THRESHOLDS.FUNDING_HIGH,
        description: this.describeFunding(m.avgFundingRate),
      });

      // Factor 2: Open Interest Level (relative to history)
      const oiScore = this.scoreOILevel(symbol, m.totalOpenInterestValue);
      factors.push({
        name: 'Open Interest Level',
        score: oiScore,
        weight: WEIGHTS.OI_LEVEL,
        value: m.totalOpenInterestValue,
        threshold: this.getAverageOI(symbol) * THRESHOLDS.OI_HIGH,
        description: this.describeOI(symbol, m.totalOpenInterestValue),
      });

      // Factor 3: Funding Rate Divergence (only if we have multiple exchanges)
      const validFundingRates = Object.values(m.fundingRateByExchange).filter(r => r !== 0);
      const fundingDivergence = validFundingRates.length >= 2
        ? this.calculateFundingDivergence(m.fundingRateByExchange)
        : 0;
      const divergenceScore = this.scoreFundingDivergence(fundingDivergence);
      factors.push({
        name: 'Funding Divergence',
        score: divergenceScore,
        weight: WEIGHTS.FUNDING_DIVERGENCE,
        value: fundingDivergence,
        threshold: THRESHOLDS.FUNDING_DIVERGENCE_HIGH,
        description: fundingDivergence > 0
          ? `${(fundingDivergence * 100).toFixed(4)}% spread between exchanges`
          : 'Insufficient data from exchanges',
      });

      // Factor 4: Price Deviation
      const priceDeviation = (m.priceDeviation || 0) / 100;
      const priceDeviationScore = this.scorePriceDeviation(priceDeviation);
      factors.push({
        name: 'Price Deviation',
        score: priceDeviationScore,
        weight: WEIGHTS.PRICE_DEVIATION,
        value: priceDeviation,
        threshold: THRESHOLDS.PRICE_DEVIATION_HIGH,
        description: `${(priceDeviation * 100).toFixed(4)}% price spread across exchanges`,
      });

      // Factor 5: OI Concentration (only if we have data from multiple exchanges)
      const validOI = Object.values(m.openInterestByExchange).filter(v => v > 0);
      const concentration = validOI.length >= 2
        ? this.calculateOIConcentration(m.openInterestByExchange)
        : 0.5; // Default to 50% if not enough data
      const concentrationScore = this.scoreOIConcentration(concentration);
      factors.push({
        name: 'OI Concentration',
        score: concentrationScore,
        weight: WEIGHTS.OI_CONCENTRATION,
        value: concentration,
        threshold: THRESHOLDS.OI_CONCENTRATION_HIGH,
        description: validOI.length >= 2
          ? `${(concentration * 100).toFixed(1)}% OI on largest exchange`
          : 'Limited exchange data available',
      });

      // Calculate weighted risk score
      const riskScore = Math.min(100, factors.reduce(
        (sum, f) => sum + f.score * f.weight,
        0
      ));

      // Determine risk level
      const riskLevel = this.getRiskLevel(riskScore);

      // Generate prediction if risk is elevated
      const prediction = riskScore >= 40
        ? this.generatePrediction(symbol, m, riskScore, factors)
        : null;

      risks.push({
        symbol,
        riskScore: Math.round(riskScore),
        riskLevel,
        factors,
        prediction,
        timestamp: data.timestamp,
      });
    }

    return risks;
  }

  private scoreFundingRate(rate: number): number {
    // Handle invalid inputs
    if (!isFinite(rate)) return 20; // Default moderate score

    const absRate = Math.abs(rate);

    // Cap at reasonable maximum (1% = 0.01)
    if (absRate > 0.01) return 100;

    if (absRate >= THRESHOLDS.FUNDING_CRITICAL) {
      return Math.min(100, 80 + ((absRate - THRESHOLDS.FUNDING_CRITICAL) / THRESHOLDS.FUNDING_CRITICAL) * 20);
    }
    if (absRate >= THRESHOLDS.FUNDING_HIGH) {
      return 60 + ((absRate - THRESHOLDS.FUNDING_HIGH) / (THRESHOLDS.FUNDING_CRITICAL - THRESHOLDS.FUNDING_HIGH)) * 20;
    }
    if (absRate >= THRESHOLDS.FUNDING_ELEVATED) {
      return 40 + ((absRate - THRESHOLDS.FUNDING_ELEVATED) / (THRESHOLDS.FUNDING_HIGH - THRESHOLDS.FUNDING_ELEVATED)) * 20;
    }
    if (absRate >= THRESHOLDS.FUNDING_NORMAL) {
      return 10 + ((absRate - THRESHOLDS.FUNDING_NORMAL) / (THRESHOLDS.FUNDING_ELEVATED - THRESHOLDS.FUNDING_NORMAL)) * 30;
    }
    return (absRate / THRESHOLDS.FUNDING_NORMAL) * 10;
  }

  private scoreOILevel(symbol: string, currentOI: number): number {
    // Handle invalid inputs
    if (!isFinite(currentOI) || currentOI < 0) return 25;

    const avgOI = this.getAverageOI(symbol);

    // If no history or invalid average, return moderate score
    if (avgOI <= 0 || !isFinite(avgOI)) return 25;

    const ratio = currentOI / avgOI;

    // Sanity check: ratio should be reasonable (0 to 10x)
    if (!isFinite(ratio) || ratio < 0 || ratio > 10) return 25;

    if (ratio >= THRESHOLDS.OI_CRITICAL) {
      return Math.min(100, 80 + ((ratio - THRESHOLDS.OI_CRITICAL) / THRESHOLDS.OI_CRITICAL) * 20);
    }
    if (ratio >= THRESHOLDS.OI_HIGH) {
      return 60 + ((ratio - THRESHOLDS.OI_HIGH) / (THRESHOLDS.OI_CRITICAL - THRESHOLDS.OI_HIGH)) * 20;
    }
    if (ratio >= THRESHOLDS.OI_ELEVATED) {
      return 40 + ((ratio - THRESHOLDS.OI_ELEVATED) / (THRESHOLDS.OI_HIGH - THRESHOLDS.OI_ELEVATED)) * 20;
    }
    if (ratio >= 1.0) {
      return 20 + ((ratio - 1.0) / (THRESHOLDS.OI_ELEVATED - 1.0)) * 20;
    }
    return Math.max(0, ratio * 20);
  }

  private scoreFundingDivergence(divergence: number): number {
    if (divergence >= THRESHOLDS.FUNDING_DIVERGENCE_CRITICAL) {
      return Math.min(100, 80 + ((divergence - THRESHOLDS.FUNDING_DIVERGENCE_CRITICAL) / THRESHOLDS.FUNDING_DIVERGENCE_CRITICAL) * 20);
    }
    if (divergence >= THRESHOLDS.FUNDING_DIVERGENCE_HIGH) {
      return 50 + ((divergence - THRESHOLDS.FUNDING_DIVERGENCE_HIGH) / (THRESHOLDS.FUNDING_DIVERGENCE_CRITICAL - THRESHOLDS.FUNDING_DIVERGENCE_HIGH)) * 30;
    }
    if (divergence >= THRESHOLDS.FUNDING_DIVERGENCE_NORMAL) {
      return 20 + ((divergence - THRESHOLDS.FUNDING_DIVERGENCE_NORMAL) / (THRESHOLDS.FUNDING_DIVERGENCE_HIGH - THRESHOLDS.FUNDING_DIVERGENCE_NORMAL)) * 30;
    }
    return (divergence / THRESHOLDS.FUNDING_DIVERGENCE_NORMAL) * 20;
  }

  private scorePriceDeviation(deviation: number): number {
    if (deviation >= THRESHOLDS.PRICE_DEVIATION_CRITICAL) {
      return Math.min(100, 80 + ((deviation - THRESHOLDS.PRICE_DEVIATION_CRITICAL) / THRESHOLDS.PRICE_DEVIATION_CRITICAL) * 20);
    }
    if (deviation >= THRESHOLDS.PRICE_DEVIATION_HIGH) {
      return 50 + ((deviation - THRESHOLDS.PRICE_DEVIATION_HIGH) / (THRESHOLDS.PRICE_DEVIATION_CRITICAL - THRESHOLDS.PRICE_DEVIATION_HIGH)) * 30;
    }
    if (deviation >= THRESHOLDS.PRICE_DEVIATION_NORMAL) {
      return 20 + ((deviation - THRESHOLDS.PRICE_DEVIATION_NORMAL) / (THRESHOLDS.PRICE_DEVIATION_HIGH - THRESHOLDS.PRICE_DEVIATION_NORMAL)) * 30;
    }
    return (deviation / THRESHOLDS.PRICE_DEVIATION_NORMAL) * 20;
  }

  private scoreOIConcentration(concentration: number): number {
    if (concentration >= THRESHOLDS.OI_CONCENTRATION_CRITICAL) {
      return Math.min(100, 80 + ((concentration - THRESHOLDS.OI_CONCENTRATION_CRITICAL) / (1 - THRESHOLDS.OI_CONCENTRATION_CRITICAL)) * 20);
    }
    if (concentration >= THRESHOLDS.OI_CONCENTRATION_HIGH) {
      return 50 + ((concentration - THRESHOLDS.OI_CONCENTRATION_HIGH) / (THRESHOLDS.OI_CONCENTRATION_CRITICAL - THRESHOLDS.OI_CONCENTRATION_HIGH)) * 30;
    }
    if (concentration >= THRESHOLDS.OI_CONCENTRATION_NORMAL) {
      return 20 + ((concentration - THRESHOLDS.OI_CONCENTRATION_NORMAL) / (THRESHOLDS.OI_CONCENTRATION_HIGH - THRESHOLDS.OI_CONCENTRATION_NORMAL)) * 30;
    }
    return (concentration / THRESHOLDS.OI_CONCENTRATION_NORMAL) * 20;
  }

  private calculateFundingDivergence(rates: { [exchange: string]: number }): number {
    const values = Object.values(rates).filter(v => v !== 0 && isFinite(v));
    if (values.length < 2) return 0;

    const max = Math.max(...values);
    const min = Math.min(...values);
    const divergence = max - min;

    // Sanity check: divergence should be reasonable (< 1%)
    if (!isFinite(divergence) || divergence < 0 || divergence > 0.01) {
      return 0;
    }
    return divergence;
  }

  private calculateOIConcentration(oiByExchange: { [exchange: string]: number }): number {
    const values = Object.values(oiByExchange).filter(v => v > 0 && isFinite(v));
    if (values.length === 0) return 0;

    const total = values.reduce((sum, v) => sum + v, 0);
    if (total <= 0 || !isFinite(total)) return 0;

    const maxOI = Math.max(...values);
    const concentration = maxOI / total;

    // Sanity check: concentration should be between 0 and 1
    if (!isFinite(concentration) || concentration < 0 || concentration > 1) {
      return 0.5; // Default to 50% if invalid
    }
    return concentration;
  }

  private getAverageOI(symbol: string): number {
    const history = this.historicalOI.get(symbol) || [];
    if (history.length === 0) return 0;
    return history.reduce((sum, v) => sum + v, 0) / history.length;
  }

  private getRiskLevel(score: number): CascadeRisk['riskLevel'] {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 40) return 'elevated';
    if (score >= 20) return 'moderate';
    return 'low';
  }

  private describeFunding(rate: number): string {
    const pct = (rate * 100).toFixed(4);
    const direction = rate > 0 ? 'longs paying shorts' : 'shorts paying longs';
    const absRate = Math.abs(rate);

    if (absRate >= THRESHOLDS.FUNDING_CRITICAL) {
      return `Critical: ${pct}% (${direction})`;
    }
    if (absRate >= THRESHOLDS.FUNDING_HIGH) {
      return `High: ${pct}% (${direction})`;
    }
    if (absRate >= THRESHOLDS.FUNDING_ELEVATED) {
      return `Elevated: ${pct}% (${direction})`;
    }
    return `Normal: ${pct}%`;
  }

  private describeOI(symbol: string, currentOI: number): string {
    const avgOI = this.getAverageOI(symbol);
    if (avgOI === 0) return 'Building historical baseline...';

    const ratio = currentOI / avgOI;
    const pctChange = ((ratio - 1) * 100).toFixed(1);

    if (ratio >= THRESHOLDS.OI_CRITICAL) {
      return `Critical: ${pctChange}% above average`;
    }
    if (ratio >= THRESHOLDS.OI_HIGH) {
      return `High: ${pctChange}% above average`;
    }
    if (ratio >= THRESHOLDS.OI_ELEVATED) {
      return `Elevated: ${pctChange}% above average`;
    }
    return `Normal: ${ratio >= 1 ? '+' : ''}${pctChange}% vs average`;
  }

  private generatePrediction(
    symbol: string,
    metrics: AggregatedData['metrics'][string],
    riskScore: number,
    factors: CascadeFactor[]
  ): CascadePrediction {
    const direction: CascadePrediction['direction'] =
      metrics.avgFundingRate > 0 ? 'long_squeeze' : 'short_squeeze';

    // Probability calculation with bounds checking
    // riskScore should be >= 40 when this is called (checked at line 181)
    const rawProbability = Math.max(0, (riskScore - 20) / 100);
    const probability = Math.min(0.85, Math.max(0.1, rawProbability));

    // Estimate impact based on OI and risk level
    // liquidationPct ranges from 3% to 10% based on risk
    const liquidationPct = 0.03 + (Math.min(100, Math.max(0, riskScore)) / 100) * 0.07;
    const totalOI = Math.max(0, metrics.totalOpenInterestValue || 0);
    const estimatedImpact = isFinite(totalOI) ? totalOI * liquidationPct : 0;

    // Trigger distance (2% to 6% from current price)
    const triggerDistance = Math.max(2, 6 - (riskScore / 100) * 4);

    // Calculate trigger price with validation
    const basePrice = metrics.oraclePrice || metrics.avgMarkPrice || 0;
    if (!isFinite(basePrice) || basePrice <= 0) {
      // Return safe defaults if price is invalid
      return {
        direction,
        probability,
        estimatedImpact: 0,
        timeWindow: '12-24 hours',
        triggerPrice: 0,
        triggerDistance,
      };
    }

    const priceMultiplier = direction === 'long_squeeze'
      ? 1 - triggerDistance / 100
      : 1 + triggerDistance / 100;
    const triggerPrice = basePrice * priceMultiplier;

    // Time window based on funding rate urgency
    const fundingFactor = factors.find(f => f.name === 'Funding Rate');
    const urgency = fundingFactor?.score ?? 30;
    const timeWindow = urgency >= 70 ? '1-4 hours' :
                       urgency >= 50 ? '4-12 hours' :
                       '12-24 hours';

    return {
      direction,
      probability: isFinite(probability) ? probability : 0.5,
      estimatedImpact: isFinite(estimatedImpact) ? estimatedImpact : 0,
      timeWindow,
      triggerPrice: isFinite(triggerPrice) ? triggerPrice : 0,
      triggerDistance: isFinite(triggerDistance) ? triggerDistance : 4,
    };
  }
}
