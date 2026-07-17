export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          payload: Json | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          payload?: Json | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          payload?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      automation_settings: {
        Row: {
          allowed_assets: string[]
          kill_switch_active: boolean
          max_daily_loss: number
          max_trade_size: number
          max_trades_per_day: number
          min_confidence: number
          mode: string
          risk_level: string
          updated_at: string
          user_id: string
        }
        Insert: {
          allowed_assets?: string[]
          kill_switch_active?: boolean
          max_daily_loss?: number
          max_trade_size?: number
          max_trades_per_day?: number
          min_confidence?: number
          mode?: string
          risk_level?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          allowed_assets?: string[]
          kill_switch_active?: boolean
          max_daily_loss?: number
          max_trade_size?: number
          max_trades_per_day?: number
          min_confidence?: number
          mode?: string
          risk_level?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      backtest_runs: {
        Row: {
          created_at: string
          equity_curve: Json
          error: string | null
          from_ts: string
          id: string
          interval: string
          kind: string
          label: string | null
          metrics: Json
          params: Json
          parent_run_id: string | null
          status: string
          strategy_id: string | null
          symbol: string
          to_ts: string
          user_id: string
        }
        Insert: {
          created_at?: string
          equity_curve?: Json
          error?: string | null
          from_ts: string
          id?: string
          interval: string
          kind?: string
          label?: string | null
          metrics?: Json
          params?: Json
          parent_run_id?: string | null
          status?: string
          strategy_id?: string | null
          symbol: string
          to_ts: string
          user_id: string
        }
        Update: {
          created_at?: string
          equity_curve?: Json
          error?: string | null
          from_ts?: string
          id?: string
          interval?: string
          kind?: string
          label?: string | null
          metrics?: Json
          params?: Json
          parent_run_id?: string | null
          status?: string
          strategy_id?: string | null
          symbol?: string
          to_ts?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "backtest_runs_parent_run_id_fkey"
            columns: ["parent_run_id"]
            isOneToOne: false
            referencedRelation: "backtest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backtest_runs_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      backtest_trades: {
        Row: {
          confidence: number | null
          created_at: string
          entry_price: number
          entry_ts: string
          exit_price: number | null
          exit_reason: string | null
          exit_ts: string | null
          id: string
          indicators: Json | null
          market_regime: string | null
          pnl: number | null
          pnl_pct: number | null
          qty: number
          run_id: string
          side: string
          symbol: string
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          entry_price: number
          entry_ts: string
          exit_price?: number | null
          exit_reason?: string | null
          exit_ts?: string | null
          id?: string
          indicators?: Json | null
          market_regime?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          qty: number
          run_id: string
          side: string
          symbol: string
          user_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          entry_price?: number
          entry_ts?: string
          exit_price?: number | null
          exit_reason?: string | null
          exit_ts?: string | null
          id?: string
          indicators?: Json | null
          market_regime?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          qty?: number
          run_id?: string
          side?: string
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "backtest_trades_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "backtest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_connections: {
        Row: {
          connector_id: string
          created_at: string
          credential_ciphertext: string | null
          health: string
          id: string
          label: string
          last_error: string | null
          last_sync_at: string | null
          read_enabled: boolean
          status: string
          trading_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          connector_id: string
          created_at?: string
          credential_ciphertext?: string | null
          health?: string
          id?: string
          label: string
          last_error?: string | null
          last_sync_at?: string | null
          read_enabled?: boolean
          status?: string
          trading_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          connector_id?: string
          created_at?: string
          credential_ciphertext?: string | null
          health?: string
          id?: string
          label?: string
          last_error?: string | null
          last_sync_at?: string | null
          read_enabled?: boolean
          status?: string
          trading_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_candles: {
        Row: {
          close: number
          created_at: string
          high: number
          id: number
          interval: string
          low: number
          open: number
          source: string
          symbol: string
          ts: string
          volume: number
        }
        Insert: {
          close: number
          created_at?: string
          high: number
          id?: number
          interval: string
          low: number
          open: number
          source?: string
          symbol: string
          ts: string
          volume?: number
        }
        Update: {
          close?: number
          created_at?: string
          high?: number
          id?: number
          interval?: string
          low?: number
          open?: number
          source?: string
          symbol?: string
          ts?: string
          volume?: number
        }
        Relationships: []
      }
      orders: {
        Row: {
          account_id: string
          created_at: string
          fees: number | null
          filled_at: string | null
          filled_price: number | null
          id: string
          limit_price: number | null
          order_type: string
          position_id: string | null
          qty: number
          side: string
          slippage_bps: number | null
          status: string
          symbol: string
          user_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          fees?: number | null
          filled_at?: string | null
          filled_price?: number | null
          id?: string
          limit_price?: number | null
          order_type?: string
          position_id?: string | null
          qty: number
          side: string
          slippage_bps?: number | null
          status?: string
          symbol: string
          user_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          fees?: number | null
          filled_at?: string | null
          filled_price?: number | null
          id?: string
          limit_price?: number | null
          order_type?: string
          position_id?: string | null
          qty?: number
          side?: string
          slippage_bps?: number | null
          status?: string
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "paper_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_accounts: {
        Row: {
          base_currency: string
          cash_balance: number
          connection_id: string | null
          created_at: string
          equity: number
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          base_currency?: string
          cash_balance?: number
          connection_id?: string | null
          created_at?: string
          equity?: number
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          base_currency?: string
          cash_balance?: number
          connection_id?: string | null
          created_at?: string
          equity?: number
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_accounts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          account_id: string
          ai_confidence: number | null
          ai_reasoning: string | null
          avg_entry: number
          closed_at: string | null
          exit_price: number | null
          exit_reason: string | null
          id: string
          opened_at: string
          qty: number
          realized_pnl: number | null
          side: string
          status: string
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          trailing_stop_pct: number | null
          user_id: string
        }
        Insert: {
          account_id: string
          ai_confidence?: number | null
          ai_reasoning?: string | null
          avg_entry: number
          closed_at?: string | null
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          opened_at?: string
          qty: number
          realized_pnl?: number | null
          side: string
          status?: string
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          trailing_stop_pct?: number | null
          user_id: string
        }
        Update: {
          account_id?: string
          ai_confidence?: number | null
          ai_reasoning?: string | null
          avg_entry?: number
          closed_at?: string | null
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          opened_at?: string
          qty?: number
          realized_pnl?: number | null
          side?: string
          status?: string
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          trailing_stop_pct?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "paper_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          autonomous_disclaimer_acked_at: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          autonomous_disclaimer_acked_at?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          autonomous_disclaimer_acked_at?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          confidence: number
          contributions: Json
          created_at: string
          entry: number
          evaluated_at: string | null
          expires_at: string | null
          id: string
          indicators: Json
          market_regime: string | null
          outcome_pnl_pct: number | null
          outcome_status: string | null
          qty: number
          reasoning: string
          resolved_at: string | null
          risk_factors: Json
          risk_level: string
          risk_reward: number | null
          side: string
          status: string
          stop_loss: number
          symbol: string
          take_profit: number
          time_horizon: string
          user_id: string
        }
        Insert: {
          confidence: number
          contributions?: Json
          created_at?: string
          entry: number
          evaluated_at?: string | null
          expires_at?: string | null
          id?: string
          indicators?: Json
          market_regime?: string | null
          outcome_pnl_pct?: number | null
          outcome_status?: string | null
          qty: number
          reasoning: string
          resolved_at?: string | null
          risk_factors?: Json
          risk_level?: string
          risk_reward?: number | null
          side: string
          status?: string
          stop_loss: number
          symbol: string
          take_profit: number
          time_horizon?: string
          user_id: string
        }
        Update: {
          confidence?: number
          contributions?: Json
          created_at?: string
          entry?: number
          evaluated_at?: string | null
          expires_at?: string | null
          id?: string
          indicators?: Json
          market_regime?: string | null
          outcome_pnl_pct?: number | null
          outcome_status?: string | null
          qty?: number
          reasoning?: string
          resolved_at?: string | null
          risk_factors?: Json
          risk_level?: string
          risk_reward?: number | null
          side?: string
          status?: string
          stop_loss?: number
          symbol?: string
          take_profit?: number
          time_horizon?: string
          user_id?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          id: string
          interval: string
          name: string
          notes: string | null
          params: Json
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          interval?: string
          name: string
          notes?: string | null
          params?: Json
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          interval?: string
          name?: string
          notes?: string | null
          params?: Json
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
